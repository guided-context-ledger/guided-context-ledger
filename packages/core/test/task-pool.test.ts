import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/events.js";

let root: string;
let log: EventLog;
const T = "work";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-taskpool-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  log = new EventLog(root);
});

async function newTask(o: { body?: string; requires?: string[]; scope?: any; addressedTo?: string[] } = {}): Promise<string> {
  const r = await log.append(T, "kyle", o.body ?? "do a thing", "task", null, {
    requires: o.requires ?? [],
    scope: o.scope,
    addressedTo: o.addressedTo,
  });
  return r.event_id;
}

test("a created task is born unassigned and sits in open_pool as needs_authorization (default human_directed)", async () => {
  const id = await newTask({ requires: ["coding"] });
  const { open_pool, total_eligible } = await log.taskPool({ actor: "claude-code", capabilities: ["coding"] });
  assert.equal(open_pool.length, 1);
  assert.equal(total_eligible, 1);
  assert.equal(open_pool[0].task_id, id);
  assert.equal(open_pool[0].eligibility, "needs_authorization"); // unassigned, not claimable without auth
  assert.equal(open_pool[0].authorized, false);
  assert.equal(open_pool[0].verification_pending, false);
});

test("requires ⊄ my capabilities → not in my pool; a capable peer still sees it (AC d)", async () => {
  await newTask({ requires: ["welding"] });
  const mine = await log.taskPool({ actor: "claude-code", capabilities: ["coding"] });
  assert.equal(mine.open_pool.length, 0);
  const peer = await log.taskPool({ actor: "welder", capabilities: ["welding", "coding"] });
  assert.equal(peer.open_pool.length, 1);
});

test("task_authorization(approved) makes it claimable_now under default policy (AC l)", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "kyle", "go ahead", "task_authorization", id, { authorization: "approved" });
  const { open_pool } = await log.taskPool({ actor: "claude-code", capabilities: [] });
  assert.equal(open_pool[0].eligibility, "claimable_now");
  assert.equal(open_pool[0].authorized, true);
  // truth stays open — authorization changes claim eligibility only, not truth
  assert.equal(open_pool[0].truth, "open");
});

test("proactive policy → claimable_now without authorization; human_directed gates it (AC k)", async () => {
  await newTask({ requires: [] });
  const pro = await log.taskPool({ actor: "x", capabilities: [], policy: "proactive" });
  assert.equal(pro.open_pool[0].eligibility, "claimable_now");
  const gated = await log.taskPool({ actor: "x", capabilities: [], policy: "human_directed" });
  assert.equal(gated.open_pool[0].eligibility, "needs_authorization");
});

test("a live claim removes the task from the unassigned pool; a stale claim returns it", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "claude-code", "taking it", "claim", id, {
    claimStatus: "claimed",
    leaseExpiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  let pool = await log.taskPool({ actor: "other", capabilities: [] });
  assert.equal(pool.open_pool.length, 0, "live-claimed task is assigned, not pool work");

  const id2 = await newTask({ requires: [] });
  await log.append(T, "claude-code", "grabbed then abandoned", "claim", id2, {
    claimStatus: "claimed",
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  pool = await log.taskPool({ actor: "other", capabilities: [] });
  assert.equal(pool.open_pool.some((r) => r.task_id === id2), true, "stale claim is re-claimable pool work");
});

test("task_state(completed) leaves the pool and is TERMINAL & IMMUTABLE — no reopen (history retained)", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "claude-code", "done", "task_state", id, { taskStatus: "completed" });
  let pool = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(pool.open_pool.length, 0);

  // `reopened` no longer exists — attempting it is rejected at append (it was tampering with settled truth).
  await assert.rejects(
    () => log.append(T, "kyle", "actually not", "task_state", id, { taskStatus: "reopened" as any }),
    /task_status/
  );

  // Even a legacy `reopened` line that somehow reached the log is inert: it can never return the task to the pool.
  await log.append(T, "kyle", "smuggled legacy reopen", "task_state", id, { taskStatus: "completed" }); // appendable…
  await fs.appendFile(
    path.join(root, "events", `${T}.jsonl`),
    JSON.stringify({ actor: "kyle", type: "task_state", parent_event_id: id, created_at: "2999-01-01T00:00:00.000Z", body: "legacy reopen", task_status: "reopened" }) + "\n",
    "utf8"
  );
  pool = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(pool.open_pool.length, 0, "a closed task stays closed; no reopen path exists");
});

test("first terminal transition wins — a later task_state cannot flip a settled truth", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "claude-code", "done", "task_state", id, { taskStatus: "completed" });
  // A later cancelled must NOT override the earlier completed (immutability), and must not return it to the pool.
  await log.append(T, "kyle", "no, cancel it", "task_state", id, { taskStatus: "cancelled" });
  const pool = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(pool.open_pool.length, 0, "still terminal — neither event reopens it");
});

test("ignored terminal attempts are retained with provenance, never silently dropped (projectTask)", async () => {
  const id = await newTask({ requires: [] });
  const winner = (await log.append(T, "claude-code", "done", "task_state", id, { taskStatus: "completed" })).event_id;
  await log.append(T, "kyle", "no, cancel it", "task_state", id, { taskStatus: "cancelled" });

  const p = await log.projectTask(T, id);
  assert.ok(p, "closed task is still inspectable via projectTask");
  assert.equal(p!.truth, "completed", "first terminal stays authoritative");
  assert.equal(p!.ignored_terminal_attempts.length, 1);
  const a = p!.ignored_terminal_attempts[0];
  assert.equal(a.actor, "kyle");
  assert.equal(a.attempted_status, "cancelled");
  assert.equal(a.reason, "already_terminal");
  assert.ok(a.event_id && a.at, "carries event_id + timestamp provenance");
  assert.equal(a.settled_by_event_id, winner, "points at the winning terminal that settled truth first (#23 provenance edge)");
});

test("projectTask returns null for an unknown task; a clean task has no ignored attempts", async () => {
  const id = await newTask({ requires: [] });
  assert.equal(await log.projectTask(T, "work#999"), null);
  const p = await log.projectTask(T, id);
  assert.deepEqual(p!.ignored_terminal_attempts, []);
});

test("forward work = a typed successor task referencing the original; lineage is visible on the row", async () => {
  const original = await newTask({ requires: [], body: "ship feature" });
  await log.append(T, "claude-code", "shipped", "task_state", original, { taskStatus: "completed" });

  // The original regressed → a `redo` successor that references it. The original is never reopened.
  const successor = (
    await log.append(T, "kyle", "feature regressed, redo it", "task", null, {
      succeeds: original,
      succession: "redo",
    })
  ).event_id;

  const { open_pool } = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(open_pool.length, 1, "only the open successor is pool work; the terminal original is history");
  assert.equal(open_pool[0].task_id, successor);
  assert.equal(open_pool[0].succeeds, original);
  assert.equal(open_pool[0].succession, "redo");
});

test("an ordinary task carries no lineage; succeeds/succession default to null", async () => {
  await newTask({ requires: [] });
  const { open_pool } = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(open_pool[0].succeeds, null);
  assert.equal(open_pool[0].succession, null);
});

test("a successor needs BOTH a target and a valid relation (paired, controlled vocab)", async () => {
  // relation without a target
  await assert.rejects(
    () => log.append(T, "kyle", "x", "task", null, { succession: "continuation" } as any),
    /succeeds/
  );
  // target without a relation
  await assert.rejects(
    () => log.append(T, "kyle", "x", "task", null, { succeeds: "work#1" } as any),
    /succession/
  );
  // invalid relation
  await assert.rejects(
    () => log.append(T, "kyle", "x", "task", null, { succeeds: "work#1", succession: "revived" as any }),
    /succession/
  );
});

test("overdue is a derived FACT with an inspectable reason; days_remaining goes negative", async () => {
  const now = Date.parse("2026-06-19T00:00:00.000Z");
  await log.append(T, "kyle", "ship", "task", null, { dueDate: "2026-06-18" });
  const r = (await log.taskPool({ actor: "x", capabilities: [], now })).open_pool[0];
  assert.equal(r.due_date, "2026-06-18");
  assert.equal(r.days_remaining, -1);
  const overdue = r.conditions.find((c) => c.condition === "overdue");
  assert.ok(overdue, "overdue condition present");
  assert.match(overdue!.reason, /due 2026-06-18; 1d past/);
});

test("a future due_date is CLEAR — not overdue, no opinion about 'soon'; days_remaining positive", async () => {
  const now = Date.parse("2026-06-19T00:00:00.000Z");
  await log.append(T, "kyle", "ship", "task", null, { dueDate: "2026-06-25" });
  const r = (await log.taskPool({ actor: "x", capabilities: [], now })).open_pool[0];
  assert.equal(r.days_remaining, 6);
  assert.equal(r.conditions.some((c) => c.condition === "overdue"), false, "no 'at-risk'/'soon' — facts only");
});

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

test("stale derives from inactivity beyond a SUPPLIED cadence, with an inspectable reason", async () => {
  await newTask({ requires: [] });
  const now = Date.now() + 10 * 24 * 60 * 60 * 1000; // 10 days on, cadence explicitly supplied
  const r = (await log.taskPool({ actor: "x", capabilities: [], now, staleCadenceMs: SEVEN_DAYS })).open_pool[0];
  const stale = r.conditions.find((c) => c.condition === "stale");
  assert.ok(stale, "stale condition present");
  assert.match(stale!.reason, /no activity for \d+d \(cadence 7d\)/);
});

test("absent a cadence policy, staleness coverage is `undetermined` at the AGGREGATE boundary — rows stay clean (#23)", async () => {
  await newTask({ requires: [] });
  const pool = await log.taskPool({ actor: "x", capabilities: [] }); // NO staleCadenceMs
  // Coverage is reported ONCE for the pool, not stamped on every row (codex the GCL coordination spec adjustment).
  assert.equal(pool.staleness_assessment.status, "undetermined");
  assert.equal(pool.staleness_assessment.reason, "no_cadence_policy");
  const r = pool.open_pool[0];
  assert.equal(r.conditions.some((c) => c.condition === "undetermined"), false, "base row is NOT decorated undetermined");
  assert.equal(r.conditions.some((c) => c.condition === "stale"), false, "and never a baked-default stale");
});

test("WITH a cadence policy, staleness coverage reads `assessed` and carries the cadence window", async () => {
  await newTask({ requires: [] });
  const pool = await log.taskPool({ actor: "x", capabilities: [], staleCadenceMs: SEVEN_DAYS });
  assert.equal(pool.staleness_assessment.status, "assessed");
  assert.equal(pool.staleness_assessment.cadence_ms, SEVEN_DAYS);
});

test("a fresh, dateless task UNDER a cadence is CLEAR — no conditions, null days_remaining", async () => {
  await newTask({ requires: [] });
  const r = (await log.taskPool({ actor: "x", capabilities: [], staleCadenceMs: SEVEN_DAYS })).open_pool[0];
  assert.deepEqual(r.conditions, [], "assessed against a cadence and genuinely fresh → clear");
  assert.equal(r.days_remaining, null);
  assert.equal(r.start_date, null);
  assert.equal(r.due_date, null);
  assert.equal(r.days_since_activity, 0);
});

test("raw temporal facts round-trip; an unparseable date is dropped at append, not stored", async () => {
  await log.append(T, "kyle", "ship", "task", null, { startDate: "2026-06-01", dueDate: "not-a-date" });
  const r = (await log.taskPool({ actor: "x", capabilities: [] })).open_pool[0];
  assert.equal(r.start_date, "2026-06-01");
  assert.equal(r.due_date, null, "garbage due_date rejected at append (keeps derived overdue sound)");
});

test("a declared blocked condition surfaces on the row + projection, with author + reason", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "claude-code", "blocked", "task_condition", id, { conditionState: "set", condition: "blocked", reason: "waiting on upstream API" });
  const r = (await log.taskPool({ actor: "x", capabilities: [] })).open_pool[0];
  const blocked = r.conditions.find((c) => c.condition === "blocked");
  assert.ok(blocked, "blocked condition on the row");
  assert.match(blocked!.reason, /upstream API/);
  const p = await log.projectTask(T, id);
  assert.equal(p!.declared_conditions.length, 1);
  assert.equal(p!.declared_conditions[0].actor, "claude-code");
  assert.equal(p!.declared_conditions[0].condition, "blocked");
});

test("clearing is by assertion identity — clearing one actor's blocker leaves another's intact", async () => {
  const id = await newTask({ requires: [] });
  const a1 = (await log.append(T, "alice", "b1", "task_condition", id, { conditionState: "set", condition: "blocked", reason: "missing parts" })).event_id;
  await log.append(T, "bob", "b2", "task_condition", id, { conditionState: "set", condition: "pending", reason: "awaiting decision" });
  // alice clears HER assertion (parent = the set's event id), not the task.
  await log.append(T, "alice", "unblocked", "task_condition", a1, { conditionState: "cleared" });

  const p = await log.projectTask(T, id);
  assert.equal(p!.declared_conditions.length, 1, "bob's pending survives alice's clear");
  assert.equal(p!.declared_conditions[0].condition, "pending");
  assert.equal(p!.declared_conditions[0].actor, "bob");
});

test("a `cleared` whose parent is NOT a task_condition:set is ignored — can't retract a blocker never asserted (#23 guard)", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "alice", "blocked", "task_condition", id, { conditionState: "set", condition: "blocked", reason: "missing parts" });
  // A clear that parents the TASK itself (not the set assertion) is a malformed retraction: the projection
  // resolves the parent, finds it isn't a compatible set, and ignores it — the blocker stands.
  await log.append(T, "mallory", "spurious clear", "task_condition", id, { conditionState: "cleared" });

  const p = await log.projectTask(T, id);
  assert.equal(p!.declared_conditions.length, 1, "blocker stands — the misaimed clear was ignored");
  assert.equal(p!.declared_conditions[0].condition, "blocked");
});

test("validation: a condition 'set' needs a declarable condition + a non-empty reason; state is required", async () => {
  const id = await newTask({ requires: [] });
  await assert.rejects(() => log.append(T, "x", "", "task_condition", id, { condition: "blocked", reason: "r" } as any), /condition_state/);
  await assert.rejects(() => log.append(T, "x", "", "task_condition", id, { conditionState: "set", reason: "r" } as any), /condition/);
  await assert.rejects(() => log.append(T, "x", "", "task_condition", id, { conditionState: "set", condition: "blocked" } as any), /reason/);
  await assert.rejects(() => log.append(T, "x", "", "task_condition", id, { conditionState: "set", condition: "overdue" as any, reason: "r" }), /condition/);
});

test("claim(completed) WITHOUT task_state(completed) → verification_pending, truth still open (AC b / §2.3)", async () => {
  const id = await newTask({ requires: [] });
  await log.append(T, "claude-code", "claim", "claim", id, { claimStatus: "claimed" });
  await log.append(T, "claude-code", "ownership done", "claim", id, { claimStatus: "completed" });
  const { open_pool } = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(open_pool.length, 1);
  assert.equal(open_pool[0].verification_pending, true);
  assert.equal(open_pool[0].truth, "open");
});

test("scope filters by project; principal_scope never gates (AC e)", async () => {
  await newTask({ requires: [], scope: { project: "alpha" } });
  await newTask({ requires: [], scope: { project: "beta", principal_scope: "secret" } });
  const alpha = await log.taskPool({ actor: "x", capabilities: [], scope: { project: "alpha" } });
  assert.equal(alpha.open_pool.length, 1);
  assert.equal(alpha.open_pool[0].scope?.project, "alpha");
  const all = await log.taskPool({ actor: "x", capabilities: [], scope: { principal_scope: "whatever" } });
  assert.equal(all.open_pool.length, 2, "principal_scope does not gate visibility in v0");
});

test("unclaimed_age_exceeded flags an old unclaimed task WITHOUT hiding it (AC g)", async () => {
  await newTask({ requires: [] });
  const future = Date.now() + 10 * 60 * 1000;
  const { open_pool } = await log.taskPool({ actor: "x", capabilities: [], now: future, staleUnclaimedMs: 1000 });
  assert.equal(open_pool.length, 1, "stale task stays VISIBLE");
  assert.deepEqual(open_pool[0].stale_reasons, ["unclaimed_age_exceeded"]);
});

test("discoverability anchor: total_eligible equals the row count (AC n)", async () => {
  await newTask({ requires: [] });
  await newTask({ requires: [] });
  const { open_pool, total_eligible } = await log.taskPool({ actor: "x", capabilities: [] });
  assert.equal(total_eligible, open_pool.length);
  assert.equal(total_eligible, 2);
});

test("validation: task_state needs a parent task and a valid status", async () => {
  await assert.rejects(() => log.append(T, "x", "b", "task_state", null, { taskStatus: "completed" }));
  const id = await newTask({});
  await assert.rejects(() => log.append(T, "x", "b", "task_state", id, {} as any));
});
