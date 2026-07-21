import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GclLedger, type RevisionEnvelope } from "../src/ledger.js";
import { appendIdentityEvent, readIdentityEvents } from "../src/identity-binding.js";
import { advanceIdentityAnchor, readIdentityAnchor, verifyAnchoredLane, validateIdentityLog } from "../src/identity-anchor.js";

const AT = "2026-07-12T00:00:00.000Z";
const SUBJECT = "principal:kyle";

async function tmp(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "gcl-anchor-")); }

/** Append an identity event AND advance the anchor to it (the store's normal accepted-append path). */
async function appendAndAnchor(root: string, ledger: GclLedger, surface: string, seqRef: string) {
  const chained = await appendIdentityEvent(root, { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: seqRef, family: "claude", surface, origin_standing: "bound" });
  await advanceIdentityAnchor(ledger, { hash: chained.hash, seq: chained.seq }, AT);
  return chained;
}

test("anchor advances into the revision chain and readback returns the head; lane verifies", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    await appendAndAnchor(root, ledger, "claude-web", "seatA");
    const last = await appendAndAnchor(root, ledger, "claude-code", "seatB");
    const anchor = await readIdentityAnchor(ledger);
    assert.equal(anchor?.seq, last.seq, "anchor tracks the identity head seq");
    assert.equal(anchor?.hash, last.hash, "anchor tracks the identity head hash");
    assert.equal((await verifyAnchoredLane(root, ledger)).status, "ok");
    // the anchor is a real revision on the canonical chain (reachable), not a sidecar
    assert.notEqual(await ledger.getHead(), "rev_genesis");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("TAIL TRUNCATION is caught: dropping the newest record (a valid shorter chain) fails closed, not recoverable", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    await appendAndAnchor(root, ledger, "claude-web", "seatA");
    await appendAndAnchor(root, ledger, "claude-code", "seatB");
    // Truncate the newest identity record — the remaining chain is internally VALID (this is exactly the
    // attack a self-contained hash chain cannot detect).
    const file = path.join(root, ".gcl", "identity-events.jsonl");
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim());
    await fs.writeFile(file, lines.slice(0, -1).join("\n") + "\n", "utf8");
    const v = await verifyAnchoredLane(root, ledger);
    assert.equal(v.ok, false);
    assert.match(v.degraded!, /tail truncation/);
    assert.notEqual(v.recoverable, true, "truncation is a hard fail, never a silent heal");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("UNANCHORED TAIL (append without anchoring) is flagged RECOVERABLE (crashed/incomplete append)", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    await appendAndAnchor(root, ledger, "claude-web", "seatA");
    // Append WITHOUT advancing the anchor (simulate a crash between append and anchor).
    await appendIdentityEvent(root, { kind: "identity_provisional", at: AT, surface: "claude-web", origin_standing: "provisional" });
    const v = await verifyAnchoredLane(root, ledger);
    assert.equal(v.ok, false);
    assert.equal(v.recoverable, true, "a lagging anchor over a valid chain is recoverable (re-anchor to head)");
    assert.match(v.degraded!, /unanchored tail/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("log-without-anchor (crash before the first anchor) is recoverable; empty↔empty verifies", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    assert.equal((await verifyAnchoredLane(root, ledger)).ok, true, "empty lane + no anchor verifies");
    await appendIdentityEvent(root, { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-web", origin_standing: "bound" });
    const v = await verifyAnchoredLane(root, ledger);
    assert.equal(v.recoverable, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the anchor revision carries a DERIVED SYSTEM provenance envelope (not a fabricated human/mind)", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    const head = await appendAndAnchor(root, ledger, "claude-web", "seatA");
    const revs = await ledger.readReachableRevisions();
    const anchorRev = revs.find((r) => r.commit_id.startsWith("idanchor_"))!;
    assert.ok(anchorRev, "an anchor revision is on the chain");
    assert.equal(anchorRev.schema_version, "0.2.0", "uses the current schema version, not null");
    const p = anchorRev.provenance!;
    assert.equal(p.evidence_kind, "derived", "the anchor is a derived integrity projection");
    assert.equal(p.posted_by, "gcl-identity-anchor");
    assert.match(p.authority_source!, /identity-integrity-invariant/, "authority is a protocol invariant, not human authz");
    assert.match(p.origin_ref!, new RegExp(`#${head.seq}:`), "origin_ref cites the exact triggering event");
    assert.equal((p as { actor_identity?: string }).actor_identity ?? null, null, "the anchor does NOT claim the subject authored it");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("validateIdentityLog accepts a valid log; rejects a hash-consistent but SEMANTICALLY invalid tail", async () => {
  const root = await tmp();
  try {
    // valid
    await appendIdentityEvent(root, { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-web", origin_standing: "bound" });
    assert.equal(validateIdentityLog(await readIdentityEvents(root)).valid, true);
    // a bound event MISSING its binding coordinates is well-hashed (appendIdentityEvent chains it) but invalid
    await appendIdentityEvent(root, { kind: "identity_bound", at: AT, surface: "claude-desktop", origin_standing: "bound" });
    const bad = validateIdentityLog(await readIdentityEvents(root));
    assert.equal(bad.valid, false);
    assert.match(bad.reason!, /binding coordinates/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a RECOVERY anchor is auditable — distinct revision, recovery marker, readback reports 'recovered'", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    await appendAndAnchor(root, ledger, "claude-web", "seatA");
    // Crash simulation: append WITHOUT anchoring, then recover (validate + recovery-anchor to head).
    const stranded = await appendIdentityEvent(root, { kind: "identity_provisional", at: AT, surface: "claude-web", origin_standing: "provisional" });
    assert.equal((await verifyAnchoredLane(root, ledger)).recoverable, true);
    assert.equal(validateIdentityLog(await readIdentityEvents(root)).valid, true, "the stranded tail is semantically valid");
    const prior = await readIdentityAnchor(ledger);
    await advanceIdentityAnchor(ledger, { hash: stranded.hash, seq: stranded.seq }, AT, { priorSeq: prior?.seq ?? null });
    const anchor = await readIdentityAnchor(ledger);
    assert.equal(anchor?.recovery, true, "the newest anchor is a recovery anchor");
    const v = await verifyAnchoredLane(root, ledger);
    assert.equal(v.status, "recovered", "readback distinguishes recovered from ok");
    const revs = await ledger.readReachableRevisions();
    const rec = revs.find((r) => r.commit_id.startsWith("idanchor_recovery"))!;
    assert.match(rec.provenance!.origin_excerpt!, /recovery: prior_anchor_seq=0 recovered_head_seq=1/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the anchor survives an INTERLEAVED non-identity revision (CAS retry advances past it)", async () => {
  const root = await tmp();
  try {
    const ledger = new GclLedger(root);
    await appendAndAnchor(root, ledger, "claude-web", "seatA");
    // A normal (non-identity) commit advances the revision HEAD between identity anchors.
    const parent = await ledger.getHead();
    const other: RevisionEnvelope = { parent_revision: parent, commit_id: "other_1", actor: "someone", session: "s", timestamp: AT, artifacts: [{ path: "notes/x.md", lane: "decisions", hash: "deadbeef" }], lanes: ["decisions"], spaces_contract_version: null, schema_version: null, provenance: null };
    await ledger.finalizeRevision(parent, other);
    // Next identity anchor must CAS past the moved HEAD and still land.
    const last = await appendAndAnchor(root, ledger, "claude-code", "seatB");
    const anchor = await readIdentityAnchor(ledger);
    assert.equal(anchor?.seq, last.seq, "the latest identity anchor is found even past an interleaved commit");
    assert.equal((await verifyAnchoredLane(root, ledger)).status, "ok");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
