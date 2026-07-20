import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/events.js";
import { renderThreadMarkdown, renderIndexMarkdown, indexRowFromEvents } from "../src/readable.js";
import type { AgentEvent } from "../src/events.js";

// P0-1 human-readable projection (ported from the live-verified private build; crucible:main#22–#27,
// live acceptance crucible:stabilization#60). The event log stays the source of truth; every append
// regenerates a durable `.md` projection beside it so a human can inspect the coordination layer
// without an agent.

let root: string;
let log: EventLog;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-readable-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  log = new EventLog(root);
});

const readable = (rel: string) => fs.readFile(path.join(root, "_readable", rel), "utf8");

/** Append a raw JSONL line the way a hosted/mediated deployment would (provenance keys the local
 * append path does not emit yet) — proves the tolerant-read path renders them faithfully. */
async function appendRawLine(thread: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(root, "events"), { recursive: true });
  await fs.appendFile(path.join(root, "events", `${thread}.jsonl`), JSON.stringify(obj) + "\n", "utf8");
}

test("append auto-generates a readable projection for the thread + INDEX", async () => {
  await log.append("main", "kyle", "first decision: ship it");
  const md = await readable("main.md");
  assert.match(md, /# main — readable projection/);
  assert.match(md, /### main#1 · kyle · message ·/);
  assert.match(md, /first decision: ship it/);
  // The projection must point back to the machine truth (crucible:main#26 refs-to-truth requirement).
  assert.match(md, /Source of truth: `events\/main\.jsonl`/);
  assert.match(md, /Generated view/);
  const index = await readable("INDEX.md");
  assert.match(index, /\[main\]\(main\.md\)/);
  assert.match(index, /coordination threads \(readable projection\)/);
});

test("projection stays current across appends (always-current guarantee)", async () => {
  await log.append("t", "a", "one");
  await log.append("t", "b", "two");
  await log.append("t", "a", "three");
  const md = await readable("t.md");
  assert.match(md, /### t#1 · a · message/);
  assert.match(md, /### t#2 · b · message/);
  assert.match(md, /### t#3 · a · message/);
  assert.match(md, /3 events/);
  // ordering preserved: #1 before #2 before #3
  assert.ok(md.indexOf("t#1") < md.indexOf("t#2"));
  assert.ok(md.indexOf("t#2") < md.indexOf("t#3"));
});

test("addressed_to and parent (re:) render in the meta line", async () => {
  const a = await log.append("main", "claude-web", "please build X", "handoff", null, {
    addressedTo: ["claude-code", "codex"],
  });
  await log.append("main", "claude-code", "done", "ack", a.event_id);
  const md = await readable("main.md");
  assert.match(md, /→ to: claude-code, codex/);
  assert.match(md, /↳ re: main#1/);
  assert.match(md, /awaiting response/); // handoff defaults requires_response=true
});

test("task family renders structured badges incl. folded terminal state", async () => {
  const t = await log.append("main", "kyle", "Build the projection hook", "task", null, {
    taskTitle: "Projection hook",
    requires: ["build", "repo-access"],
  });
  // still open → state: open
  let md = await readable("main.md");
  assert.match(md, /\*\*task\*\* "Projection hook" · state: open · requires: build, repo-access/);
  // close it → the SAME creation event now annotates state: completed (folded truth)
  await log.append("main", "claude-code", "shipped", "task_state", t.event_id, {
    taskStatus: "completed",
    reason: "landed in events.ts",
  });
  md = await readable("main.md");
  assert.match(md, /state: completed/);
  assert.match(md, /\*\*task_state\*\* → completed — landed in events\.ts/);
});

test("provenance (principal / mediated_by) from hosted-deployment logs surfaces in the projection", async () => {
  // Written the way a mediated/hosted deployment writes it — the tolerant-read path.
  await appendRawLine("main", {
    actor: "claude-web",
    type: "message",
    parent_event_id: null,
    created_at: "2026-07-08T01:50:18.458Z",
    body: "owner directive",
    principal: "kyle",
    mediated_by: "claude-connector",
  });
  await log.renderAllReadable();
  const md = await readable("main.md");
  assert.match(md, /by kyle/);
  assert.match(md, /via claude-connector/);
});

test("resolves (batch-close refs) from hosted-deployment logs render as closes:", async () => {
  await appendRawLine("main", {
    actor: "a",
    type: "message",
    parent_event_id: null,
    created_at: "2026-07-08T02:00:00.000Z",
    body: "reconciliation sweep",
    resolves: ["main#7", "other#3"],
  });
  await log.renderAllReadable();
  const md = await readable("main.md");
  assert.match(md, /✓ closes: main#7, other#3/);
});

test("renderAllReadable backfills every thread + index (post-deploy migration)", async () => {
  // Simulate threads that already exist with no NEW event coming (the migration case).
  const other = new EventLog(root);
  await other.append("alpha", "a", "a1");
  await other.append("beta", "b", "b1");
  // wipe the _readable dir to prove backfill regenerates from the logs alone
  await fs.rm(path.join(root, "_readable"), { recursive: true, force: true });
  const res = await log.renderAllReadable();
  assert.equal(res.threads, 2);
  assert.match(await readable("alpha.md"), /### alpha#1 · a · message/);
  assert.match(await readable("beta.md"), /### beta#1 · b · message/);
  const index = await readable("INDEX.md");
  assert.match(index, /\[alpha\]\(alpha\.md\)/);
  assert.match(index, /\[beta\]\(beta\.md\)/);
});

test("INDEX sorts by last activity, most recent first", async () => {
  await log.append("old", "a", "old event");
  await new Promise((r) => setTimeout(r, 5));
  await log.append("new", "b", "new event");
  const index = await readable("INDEX.md");
  assert.ok(index.indexOf("[new]") < index.indexOf("[old]"), "most-recent thread should be listed first");
});

test("pure renderThreadMarkdown handles an empty thread without throwing", () => {
  const md = renderThreadMarkdown("empty", []);
  assert.match(md, /# empty — readable projection/);
  assert.match(md, /No events yet/);
});

test("table cells with pipes/newlines are escaped so the INDEX table never breaks", () => {
  const ev: AgentEvent = {
    seq: 1, event_id: "x#1", thread: "x", actor: "a", type: "message",
    parent_event_id: null, created_at: "2026-07-08T00:00:00.000Z",
    body: "has a | pipe\nand a newline", addressed_to: [], requires_response: false,
    claim_status: null, lease_expires_at: null, task_title: null, requires: [], role: null,
    scope: null, succeeds: null, succession: null, start_date: null, due_date: null,
    task_status: null, condition: null, condition_state: null, authorization: null,
    reason: null, result_refs: [], mediated_by: null, principal: null, resolves: [],
  };
  const index = renderIndexMarkdown("ws", [indexRowFromEvents("x", [ev])]);
  assert.match(index, /has a \\\| pipe/); // literal pipe escaped so it can't be read as a column separator
  // the table row must be a single line — no raw newline from the body leaks into the row
  const row = index.split("\n").find((l) => l.startsWith("| [x]"))!;
  assert.ok(row && !row.includes("\n"));
  assert.doesNotMatch(index, /pipe\nand a newline/); // the body's newline was flattened, not emitted raw
});

test("codex public-repo#49: a render that finishes LAST re-reads under the projection lock — no stale overwrite", async () => {
  const t = "race49";
  const A = new EventLog(root);
  await A.append(t, "a", "older-e1");
  // Freeze the projection by HOLDING its cross-process lock, then start an "older" render (initiated while the
  // log is [e1]). Under the old code it would read [e1] immediately and could rename that stale snapshot over a
  // newer one; under the fix it re-reads INSIDE the lock, after e2 has landed.
  const readableDir = path.join(root, "_readable");
  await fs.mkdir(readableDir, { recursive: true });
  const lockDir = path.join(readableDir, ".projection.lock");
  await fs.mkdir(lockDir); // hold the projection lock
  const olderRender = A.renderReadable(t); // blocks on the held lock; re-reads AFTER acquiring
  const B = new EventLog(root);
  const newerAppend = B.append(t, "b", "NEWEST-e2"); // un-awaited; its own render hook also blocks
  const threadFile = path.join(root, "events", `${t}.jsonl`);
  for (let i = 0; i < 400; i++) {
    if ((await fs.readFile(threadFile, "utf8").catch(() => "")).includes("NEWEST-e2")) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await fs.rmdir(lockDir); // release → both renders proceed, serialized, each re-reading the full log
  await Promise.all([olderRender, newerAppend]);
  const md = await readable(`${t}.md`);
  assert.match(md, /older-e1/, "older event present");
  assert.match(md, /NEWEST-e2/, "the last-finishing render re-read the newest event under the lock — no stale overwrite");
  // INDEX must ALSO reflect the newest event, not just list the thread (codex public-repo#52): the row's
  // Latest-event column shows NEWEST-e2 and the Events count is 2 — proving no stale INDEX render either.
  const idx = await readable("INDEX.md");
  const idxRow = idx.split("\n").find((l) => l.includes(t));
  assert.ok(idxRow, "INDEX has a row for the thread");
  assert.match(idxRow!, /NEWEST-e2/, "INDEX Latest-event column reflects the newest event (no stale INDEX render)");
  assert.match(idxRow!, /\| 2 \|/, "INDEX Events count reflects both appends (2)");
});
