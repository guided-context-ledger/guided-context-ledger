import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog, EventError } from "../src/events.js";

let root: string;
let log: EventLog;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-events-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  log = new EventLog(root);
});

test("append then read round-trips with server-assigned seq and event_id", async () => {
  const r = await log.append("t", "claude", "hello");
  assert.equal(r.seq, 1);
  assert.equal(r.event_id, "t#1");
  assert.ok(r.created_at && !Number.isNaN(Date.parse(r.created_at)));
  const { events, latest_seq } = await log.read("t");
  assert.equal(latest_seq, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].body, "hello");
  assert.equal(events[0].actor, "claude");
  assert.equal(events[0].type, "message");
});

test("seq is the line ordinal and increments", async () => {
  await log.append("t", "a", "one");
  await log.append("t", "b", "two");
  const r3 = await log.append("t", "a", "three");
  assert.equal(r3.seq, 3);
  const { events } = await log.read("t");
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(events.map((e) => e.body), ["one", "two", "three"]);
});

test("cursor: read(after_seq) returns only newer events", async () => {
  for (let i = 1; i <= 5; i++) await log.append("t", "a", `e${i}`);
  const { events, latest_seq } = await log.read("t", 3);
  assert.equal(latest_seq, 5);
  assert.deepEqual(events.map((e) => e.seq), [4, 5]);
});

test("event type is validated; ack/handoff/conflict allowed", async () => {
  await log.append("t", "a", "ok", "ack");
  await log.append("t", "a", "ok", "handoff");
  const { events } = await log.read("t");
  assert.deepEqual(events.map((e) => e.type), ["ack", "handoff"]);
  await assert.rejects(
    () => log.append("t", "a", "x", "bogus" as any),
    (e) => e instanceof EventError && (e as EventError).code === "BAD_TYPE"
  );
});

test("parent_event_id is carried for causal links", async () => {
  await log.append("t", "a", "root");
  await log.append("t", "b", "reply", "message", "t#1");
  const { events } = await log.read("t");
  assert.equal(events[1].parent_event_id, "t#1");
});

test("actor is required", async () => {
  await assert.rejects(
    () => log.append("t", "  ", "x"),
    (e) => e instanceof EventError && (e as EventError).code === "BAD_ACTOR"
  );
});

for (const bad of ["../escape", "a/b", "..", "with space", "x".repeat(200)]) {
  test(`invalid thread id rejected: ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(
      () => log.append(bad, "a", "x"),
      (e) => e instanceof EventError && (e as EventError).code === "BAD_THREAD"
    );
  });
}

test("body over the size cap is rejected", async () => {
  await assert.rejects(
    () => log.append("t", "a", "x".repeat(200_001)),
    (e) => e instanceof EventError && (e as EventError).code === "BODY_TOO_LARGE"
  );
});

test("append to a missing workspace root throws (no silent create)", async () => {
  const missing = new EventLog(path.join(root, "ghost"));
  await assert.rejects(
    () => missing.append("t", "a", "x"),
    (e) => e instanceof EventError && (e as EventError).code === "WORKSPACE_MISSING"
  );
});

test("concurrent appends do not lose or corrupt events (lock works)", async () => {
  const N = 40;
  await Promise.all(Array.from({ length: N }, (_, i) => log.append("race", `actor${i % 4}`, `body-${i}`)));
  const { events, latest_seq, corrupt } = await log.read("race");
  assert.equal(corrupt, 0);
  assert.equal(latest_seq, N);
  assert.equal(events.length, N);
  // contiguous seq 1..N
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: N }, (_, i) => i + 1));
  // every body present exactly once
  const bodies = new Set(events.map((e) => e.body));
  assert.equal(bodies.size, N);
});

test("presence records last-active per actor", async () => {
  await log.append("t", "claude", "hi");
  const { presence } = await log.read("t", 0, 0, "codex");
  assert.ok(presence.claude, "claude should have presence from append");
  assert.ok(presence.codex, "codex should have presence from read");
});

test("long-poll returns immediately when events already exist", async () => {
  await log.append("t", "a", "x");
  const start = Date.now();
  const { events } = await log.read("t", 0, 2000);
  assert.equal(events.length, 1);
  assert.ok(Date.now() - start < 1000, "should not have waited");
});

test("long-poll times out and returns empty when no new events", async () => {
  await log.append("t", "a", "x");
  const start = Date.now();
  const { events } = await log.read("t", 1, 800); // after the only event
  const elapsed = Date.now() - start;
  assert.equal(events.length, 0);
  assert.ok(elapsed >= 700, `should have waited ~800ms, waited ${elapsed}`);
});

test("corrupt lines are skipped and counted, not fatal", async () => {
  await log.append("t", "a", "good1");
  // manually inject a malformed line
  await fs.appendFile(path.join(root, "events", "t.jsonl"), "this is not json\n", "utf8");
  await log.append("t", "a", "good2");
  const { events, corrupt, latest_seq } = await log.read("t");
  assert.equal(latest_seq, 3); // 3 physical lines
  assert.equal(corrupt, 1);
  assert.deepEqual(events.map((e) => e.body), ["good1", "good2"]);
});

test("listThreads returns thread ids", async () => {
  await log.append("alpha", "a", "x");
  await log.append("beta", "a", "y");
  assert.deepEqual(await log.listThreads(), ["alpha", "beta"]);
});
