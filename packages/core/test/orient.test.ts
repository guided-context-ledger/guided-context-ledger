import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/events.js";

let root: string;
let log: EventLog;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-orient-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  log = new EventLog(root);
});

test("overview of an empty vault has no threads", async () => {
  const ov = await log.overview("claude");
  assert.deepEqual(ov.threads, []);
});

test("overview reports per-thread cursor state relative to the actor", async () => {
  await log.append("alpha", "claude", "a1");
  await log.append("alpha", "codex", "a2");
  await log.append("alpha", "codex", "a3");
  await log.append("beta", "claude", "b1");

  const ov = await log.overview("claude");
  const alpha = ov.threads.find((t) => t.thread === "alpha")!;
  const beta = ov.threads.find((t) => t.thread === "beta")!;

  assert.equal(alpha.latest_seq, 3);
  assert.equal(alpha.my_last_seq, 1); // claude's last post in alpha was seq 1
  assert.equal(alpha.unread, 2); // seq 2,3 are after claude's last
  assert.equal(alpha.last_event!.actor, "codex");
  assert.equal(alpha.last_event!.summary, "a3");
  assert.equal(alpha.needs_me, true); // codex posted last, claude hasn't caught up

  assert.equal(beta.my_last_seq, 1);
  assert.equal(beta.unread, 0);
  assert.equal(beta.needs_me, false); // claude posted last
});

test("needs_me is false when the actor posted the latest event", async () => {
  await log.append("t", "codex", "c1");
  await log.append("t", "claude", "c2");
  const ov = await log.overview("claude");
  const t = ov.threads.find((x) => x.thread === "t")!;
  assert.equal(t.needs_me, false);
  assert.equal(t.unread, 0);
});

test("a never-seen thread is fully unread and needs_me", async () => {
  await log.append("t", "codex", "hi");
  const ov = await log.overview("claude");
  const t = ov.threads.find((x) => x.thread === "t")!;
  assert.equal(t.my_last_seq, 0);
  assert.equal(t.unread, 1);
  assert.equal(t.needs_me, true);
});

test("overview records presence for the orienting actor", async () => {
  await log.append("t", "codex", "hi");
  const ov = await log.overview("claude");
  assert.ok(ov.presence.claude, "claude presence set by orient");
  assert.ok(ov.presence.codex, "codex presence set by its append");
});

// --- structured addressing / open_for_me (the GCL coordination spec) ---

test("a terminal ack quiets needs_me (no ping-pong on closed loops)", async () => {
  await log.append("t", "claude-code", "my contribution");
  await log.append("t", "codex", "ack", "ack", "t#1");
  const ov = await log.overview("claude-code");
  const t = ov.threads.find((x) => x.thread === "t")!;
  assert.equal(t.last_event!.type, "ack");
  assert.equal(t.needs_me, false, "latest event is a terminal ack → loop closed");
});

test("a handoff addressed to me survives later acks from others (the live bug)", async () => {
  // handoff to claude-code, then two unrelated acks from peers close THEIR loop.
  await log.append("t", "claude", "build this", "handoff", null, { addressedTo: ["claude-code"] });
  await log.append("t", "codex", "ack the plan", "ack", "t#1");
  await log.append("t", "claude", "ack codex", "ack", "t#2");

  const ov = await log.overview("claude-code");
  const t = ov.threads.find((x) => x.thread === "t")!;
  assert.equal(t.needs_me, true, "open handoff keeps the thread flagged despite terminal acks");
  assert.equal(t.open_for_me, 1);

  const item = ov.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.ok(item, "the handoff is listed in open_for_me");
  assert.equal(item.source, "structured");
  assert.equal(item.actor, "claude");
});

test("open_for_me clears only after the addressee causally responds", async () => {
  await log.append("t", "claude", "build this", "handoff", null, { addressedTo: ["claude-code"] });
  // a non-causal post by claude-code does NOT close it (no parent link)
  await log.append("t", "claude-code", "unrelated note");
  let ov = await log.overview("claude-code");
  assert.equal(ov.open_for_me.length, 1, "non-causal post leaves the obligation open");

  // a causally-linked response (parent = the handoff) closes it
  await log.append("t", "claude-code", "on it", "handoff", "t#1");
  ov = await log.overview("claude-code");
  assert.equal(ov.open_for_me.length, 0, "causal response claims/closes the obligation");
  const t = ov.threads.find((x) => x.thread === "t")!;
  assert.equal(t.needs_me, false);
});

test("requires_response defaults by type and can be overridden", async () => {
  await log.append("t", "claude", "fyi", "message", null, { addressedTo: ["claude-code"] }); // message → no response owed
  await log.append("t", "claude", "please look", "handoff", null, {
    addressedTo: ["claude-code"],
    requiresResponse: false, // explicit override on a handoff
  });
  const ov = await log.overview("claude-code");
  assert.equal(ov.open_for_me.length, 0, "addressed message and opted-out handoff are not obligations");
});

// Directed-only heuristic bridge — codex regression matrix (the GCL coordination spec).
// Each case is its own thread so seq is stable; "seed" makes claude-code a known actor.
async function heuristicHits(thread: string, body: string): Promise<boolean> {
  await log.append("seed", "claude-code", "present");
  await log.append(thread, "claude", body, "handoff");
  const ov = await log.overview("claude-code");
  const item = ov.open_for_me.find((o) => o.event_id === `${thread}#1`);
  if (item) assert.equal(item.source, "heuristic");
  return !!item;
}

test("directed legacy handoffs surface as heuristic", async () => {
  assert.ok(await heuristicHits("arrow", "HANDOFF → claude-code: build the placard"), "→ actor");
  assert.ok(await heuristicHits("at", "@claude-code please build"), "@actor");
  assert.ok(await heuristicHits("hdr1", "claude-code (build): do X"), "actor (role):");
  assert.ok(await heuristicHits("hdr2", "claude-code: do X"), "actor:");
});

test("undirected prose mentions do NOT surface (false-positive guard)", async () => {
  assert.equal(await heuristicHits("list", "closed the codex, claude-code, and Gemini sessions"), false, "list mention");
  assert.equal(await heuristicHits("own", "needs_me v0 owned by claude-code"), false, "ownership mention");
  assert.equal(await heuristicHits("coder", "claude-coder is a different tool entirely"), false, "claude-coder != claude-code");
});

test("an event addressed to someone else is not open for me", async () => {
  await log.append("t", "claude", "build this", "handoff", null, { addressedTo: ["codex"] });
  const ov = await log.overview("claude-code");
  assert.equal(ov.open_for_me.length, 0);
});
