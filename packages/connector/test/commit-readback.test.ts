import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault, GclLedger, sha256Text, STAMPED_FROM, type RevisionArtifact } from "@guided-context-ledger/core";

// Proves the slim ungated commit→readback wiring that gcl_commit / gcl_readback use:
// build an envelope from hashed artifacts → finalizeRevision (CAS + append + HEAD advance) →
// readReachableRevisions reconstructs the chain. No commit engine, no enforcement, no onboard gate.

let root: string;
const vault = () => new Vault(root);
const ledger = () => new GclLedger(root);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-connector-smoke-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Mirror of the connector's gcl_commit body (slim, ungated).
async function slimCommit(actor: string, artifacts: { path: string; lane: string }[]) {
  const expected = await ledger().getHead();
  const arts: RevisionArtifact[] = [];
  for (const a of artifacts) {
    const content = await vault().read(a.path);
    arts.push({ path: a.path, lane: a.lane, hash: sha256Text(content) });
  }
  const lanes = [...new Set(arts.map((a) => a.lane))].sort();
  const timestamp = "2026-06-16T00:00:00.000Z"; // fixed for determinism in the test
  const commit_id = `cmt_${sha256Text(`${actor}:${timestamp}:${JSON.stringify(arts)}`).slice(0, 16)}`;
  return ledger().finalizeRevision(expected, {
    parent_revision: expected,
    commit_id,
    actor,
    session: "",
    timestamp,
    artifacts: arts,
    lanes,
    spaces_contract_version: null,
    schema_version: STAMPED_FROM,
    provenance: { principal_id: actor, principal_source: "self_report", actor_identity: actor },
  });
}

test("fresh workspace starts at rev_genesis with an empty chain", async () => {
  assert.equal(await ledger().getHead(), "rev_genesis");
  assert.deepEqual(await ledger().readReachableRevisions(), []);
});

test("slim commit advances HEAD and readback reconstructs the chain", async () => {
  await vault().write("notes/decision.md", "# Decision\nShip the connector.", undefined);
  const rec = await slimCommit("claude-cli", [{ path: "notes/decision.md", lane: "notes" }]);

  // HEAD advanced to the new revision id
  assert.equal(await ledger().getHead(), rec.revision_id);
  assert.match(rec.revision_id, /^rev_[0-9a-f]{24}$/);
  assert.equal(rec.parent_revision, "rev_genesis");

  // readback reconstructs exactly one reachable revision, no orphans
  const chain = await ledger().readReachableRevisions();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].revision_id, rec.revision_id);
  assert.equal(chain[0].artifacts[0].path, "notes/decision.md");
  assert.equal((await ledger().readUnreachableRevisions()).length, 0);
});

test("a second commit chains onto the first (parent links walk back to genesis)", async () => {
  await vault().write("notes/second.md", "# Second\nMore context.", undefined);
  const head1 = await ledger().getHead();
  const rec2 = await slimCommit("claude-cli", [{ path: "notes/second.md", lane: "notes" }]);

  assert.equal(rec2.parent_revision, head1);
  const chain = await ledger().readReachableRevisions();
  assert.equal(chain.length, 2);
  assert.equal(chain[0].parent_revision, "rev_genesis"); // oldest first
  assert.equal(chain[1].revision_id, rec2.revision_id);
});

test("stale expected_revision is rejected (CAS conflict, ungated still safe)", async () => {
  await vault().write("notes/third.md", "# Third", undefined);
  // commit against a stale parent (genesis) after HEAD has moved
  await assert.rejects(
    () =>
      ledger().finalizeRevision("rev_genesis", {
        parent_revision: "rev_genesis",
        commit_id: "cmt_stale",
        actor: "claude-cli",
        session: "",
        timestamp: "2026-06-16T00:00:00.000Z",
        artifacts: [{ path: "notes/third.md", lane: "notes", hash: sha256Text("# Third") }],
        lanes: ["notes"],
        spaces_contract_version: null,
        schema_version: STAMPED_FROM,
        provenance: { principal_id: "claude-cli", principal_source: "self_report" },
      }),
    /HEAD changed/
  );
});
