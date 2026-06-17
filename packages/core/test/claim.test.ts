import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog, EventError } from "../src/events.js";

// Claim/lease projection — the GCL coordination spec ratified v0.
// AC gate (codex #196): (a) race → first seq wins; (b) loser sees claimed-by-other and defers;
// (c) expired claim surfaces stale + re-claimable; (d) explicit renewal extends lease;
// (e) release/completed frees the item; plus: a claim is not a causal response, and a claim
// as the latest event quiets needs_me.

let root: string;
let log: EventLog;

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString(); // -1h

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-claim-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  log = new EventLog(root);
});

// A work item open for BOTH codex and claude-code (the race surface).
async function seedSharedWorkItem() {
  await log.append("t", "claude", "build the thing", "handoff", null, {
    addressedTo: ["codex", "claude-code"],
  });
}

test("a live claim by another actor suppresses the item from my open_for_me", async () => {
  await seedSharedWorkItem();
  await log.append("t", "claude-code", "taking this", "claim", "t#1", {
    claimStatus: "claimed",
    leaseExpiresAt: future(),
  });

  const codex = await log.overview("codex");
  assert.equal(codex.open_for_me.length, 0, "codex should not see work claude-code is actively holding");
  const t = codex.threads.find((x) => x.thread === "t")!;
  assert.equal(t.needs_me, false, "claimed-by-other does not need me");
});

test("the claimant sees the item as owned/in-progress (mine), not suppressed", async () => {
  await seedSharedWorkItem();
  const exp = future();
  await log.append("t", "claude-code", "taking this", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: exp });

  const me = await log.overview("claude-code");
  const item = me.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.ok(item, "owned work still surfaces for the claimant");
  assert.ok(item.claim, "carries a claim annotation");
  assert.equal(item.claim!.mine, true);
  assert.equal(item.claim!.claimed_by, "claude-code");
  assert.equal(item.claim!.stale, false);
  assert.equal(item.claim!.expires, exp);
});

test("first-seq-wins: the earliest live claim owns it, later claims defer", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "mine", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });
  await log.append("t", "claude-code", "no, mine", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });

  const cc = await log.overview("claude-code");
  assert.equal(cc.open_for_me.length, 0, "later claimant defers to the first-seq owner");

  const codex = await log.overview("codex");
  const item = codex.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.equal(item.claim!.mine, true, "first-seq claimant owns it");
});

test("an expired claim surfaces stale and is re-claimable (not suppressed)", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grabbing", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: past() });

  const cc = await log.overview("claude-code");
  const item = cc.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.ok(item, "a stale claim does not suppress — the item re-enters the pool");
  assert.equal(item.claim!.stale, true);
  assert.equal(item.claim!.claimed_by, "codex");
  assert.equal(item.claim!.mine, false);
});

test("takeover: re-claiming an abandoned (expired) item transfers ownership", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grabbing", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: past() });
  await log.append("t", "claude-code", "it lapsed, taking over", "claim", "t#1", {
    claimStatus: "claimed",
    leaseExpiresAt: future(),
  });

  const cc = await log.overview("claude-code");
  assert.equal(cc.open_for_me.find((o) => o.event_id === "t#1")!.claim!.mine, true, "takeover succeeds");
  const codex = await log.overview("codex");
  assert.equal(codex.open_for_me.length, 0, "the abandoning actor no longer owns it");
});

test("renewal: a same-actor re-claim extends a lapsing lease back to live", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grab", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: past() });
  await log.append("t", "codex", "renew", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });

  const codex = await log.overview("codex");
  assert.equal(codex.open_for_me.find((o) => o.event_id === "t#1")!.claim!.stale, false, "renewed lease is live");
  const cc = await log.overview("claude-code");
  assert.equal(cc.open_for_me.length, 0, "renewed claim suppresses others again");
});

test("release frees the item back to the pool", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grab", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });
  await log.append("t", "codex", "never mind", "claim", "t#1", { claimStatus: "released" });

  const cc = await log.overview("claude-code");
  const item = cc.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.ok(item, "released item is open again");
  assert.equal(item.claim, undefined, "no live claim annotation after release");
});

test("completed frees ownership (the work item still closes by causal response rules)", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grab", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });
  await log.append("t", "codex", "done owning", "claim", "t#1", { claimStatus: "completed" });

  const cc = await log.overview("claude-code");
  assert.ok(cc.open_for_me.find((o) => o.event_id === "t#1"), "completed claim does not keep others suppressed");
});

test("a non-owner release is ignored (cannot free someone else's live claim)", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grab", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });
  await log.append("t", "claude-code", "i release codex's claim", "claim", "t#1", { claimStatus: "released" });

  const cc = await log.overview("claude-code");
  assert.equal(cc.open_for_me.length, 0, "codex still owns it; a stranger's release does nothing");
});

test("a claim is NOT a causal response — the claimant still owes the work", async () => {
  await log.append("t", "claude", "build this", "handoff", null, { addressedTo: ["claude-code"] });
  await log.append("t", "claude-code", "on it", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });

  const me = await log.overview("claude-code");
  const item = me.open_for_me.find((o) => o.event_id === "t#1")!;
  assert.ok(item, "claiming does not close the obligation");
  assert.equal(item.claim!.mine, true, "it is surfaced as my in-progress work");

  // a real causal response DOES close it
  await log.append("t", "claude-code", "shipped", "message", "t#1");
  const after = await log.overview("claude-code");
  assert.equal(after.open_for_me.length, 0, "a non-claim causal response closes the item");
});

test("a claim as the latest event quiets needs_me", async () => {
  await log.append("t", "claude", "for codex", "handoff", null, { addressedTo: ["codex"] });
  await log.append("t", "codex", "mine", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: future() });

  // claude-code is not addressed and owes nothing; a claim by codex must not ping it.
  const cc = await log.overview("claude-code");
  const t = cc.threads.find((x) => x.thread === "t")!;
  assert.equal(t.last_event!.type, "claim");
  assert.equal(t.needs_me, false, "a claim by another actor is terminal for the needs_me heuristic");
});

test("an omitted lease defaults to a finite window (not indefinite)", async () => {
  await seedSharedWorkItem();
  await log.append("t", "codex", "grab, default lease", "claim", "t#1", { claimStatus: "claimed" });
  const ev = (await log.read("t", 1)).events.find((e) => e.type === "claim")!;
  assert.ok(ev.lease_expires_at, "default lease stamped");
  assert.ok(Date.parse(ev.lease_expires_at!) > Date.now(), "default lease is in the future");
});

test("validation: a claim must reference a work item and carry a status", async () => {
  await assert.rejects(
    () => log.append("t", "codex", "bad", "claim", null, { claimStatus: "claimed" }),
    (e) => e instanceof EventError && e.code === "CLAIM_NO_PARENT"
  );
  await assert.rejects(
    () => log.append("t", "codex", "bad", "claim", "t#1"),
    (e) => e instanceof EventError && e.code === "BAD_CLAIM_STATUS"
  );
  await assert.rejects(
    () => log.append("t", "codex", "bad", "claim", "t#1", { claimStatus: "claimed", leaseExpiresAt: "not-a-date" }),
    (e) => e instanceof EventError && e.code === "BAD_LEASE"
  );
});
