import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GclLedger, LedgerError, RevisionEnvelope } from "../src/ledger.js";

let root: string;
let ledger: GclLedger;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-ledger-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  ledger = new GclLedger(root);
});

function envelope(commitId = "cmt_test"): RevisionEnvelope {
  return {
    parent_revision: "rev_genesis",
    commit_id: commitId,
    actor: "codex",
    session: "s1",
    timestamp: "2026-06-13T00:00:00Z",
    artifacts: [
      { path: ".gcl/projects/demo/state.yml", lane: "project_state", hash: "b" },
      { path: ".gcl/projects/demo/decisions.jsonl", lane: "decisions", hash: "a" },
    ],
    lanes: ["project_state", "decisions"],
    spaces_contract_version: null,
    schema_version: "0.1.1",
  };
}

test("missing HEAD reads as rev_genesis", async () => {
  assert.equal(await ledger.getHead(), "rev_genesis");
});

test("revision ids are deterministic and sort artifacts/lanes", async () => {
  const a = envelope();
  const b = { ...a, artifacts: [...a.artifacts].reverse(), lanes: [...a.lanes].reverse() };
  assert.equal(ledger.revisionId(a), ledger.revisionId(b));
  assert.match(ledger.revisionId(a), /^rev_[0-9a-f]{24}$/);
});

test("finalizeRevision appends ledger and advances HEAD", async () => {
  const record = await ledger.finalizeRevision("rev_genesis", envelope());
  assert.equal(await ledger.getHead(), record.revision_id);
  assert.deepEqual(await ledger.readRevisions(), [record]);
});

test("concurrent finalize against same parent has exactly one winner", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => ledger.finalizeRevision("rev_genesis", envelope(`cmt_${i}`)))
  );
  const winners = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as LedgerError).code === "CONFLICT");
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 5);
  assert.equal((await ledger.readRevisions()).length, 1);
});

test("readReachableRevisions is empty at genesis", async () => {
  assert.deepEqual(await ledger.readReachableRevisions(), []);
});

test("readReachableRevisions returns the full chain genesis->HEAD, oldest first", async () => {
  const r1 = await ledger.finalizeRevision("rev_genesis", envelope("cmt_1"));
  const r2 = await ledger.finalizeRevision(r1.revision_id, { ...envelope("cmt_2"), parent_revision: r1.revision_id });
  const reachable = await ledger.readReachableRevisions();
  assert.deepEqual(reachable.map((r) => r.revision_id), [r1.revision_id, r2.revision_id]);
  assert.deepEqual(reachable, await ledger.readRevisions(), "clean chain matches raw ledger order");
});

test("an unreachable crash entry is excluded from reachable but surfaced as a recovery candidate (Inv 16)", async () => {
  const r1 = await ledger.finalizeRevision("rev_genesis", envelope("cmt_1"));
  // Simulate a crash between Stage 5's ledger append and HEAD advance: the ledger gains an entry
  // parented on the current HEAD, but HEAD is never moved to it.
  const crashEnv = { ...envelope("cmt_crash"), parent_revision: r1.revision_id };
  const crashRec = { ...crashEnv, revision_id: ledger.revisionId(crashEnv) };
  await fs.appendFile(path.join(root, ".gcl/ledger/revisions.jsonl"), JSON.stringify(crashRec) + "\n", "utf8");

  assert.equal((await ledger.readRevisions()).length, 2, "raw ledger retains the crash entry");
  assert.equal(await ledger.getHead(), r1.revision_id, "HEAD never advanced to the crash entry");
  assert.deepEqual(
    (await ledger.readReachableRevisions()).map((r) => r.revision_id),
    [r1.revision_id],
    "only the HEAD-reachable revision is authoritative"
  );
  assert.deepEqual(
    (await ledger.readUnreachableRevisions()).map((r) => r.revision_id),
    [crashRec.revision_id],
    "the crash entry is a recovery candidate, not valid state"
  );
});

test("a HEAD pointing at a missing revision degrades to empty, never throws (Inv 17)", async () => {
  await ledger.finalizeRevision("rev_genesis", envelope("cmt_1"));
  await fs.writeFile(path.join(root, ".gcl/HEAD"), "rev_does_not_exist\n", "utf8");
  assert.deepEqual(await ledger.readReachableRevisions(), [], "broken HEAD yields no authoritative state");
  // every raw entry becomes a recovery candidate rather than crashing reconstruction
  assert.equal((await ledger.readUnreachableRevisions()).length, 1);
});
