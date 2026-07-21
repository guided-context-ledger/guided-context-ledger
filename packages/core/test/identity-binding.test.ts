import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isDurableSeatHandle,
  isLegalTransition,
  normalizeToken,
  bindingKey,
  buildIdentityEvent,
  chainHash,
  projectBindings,
  evaluateContact,
  verifyIdentityChain,
  appendIdentityEvent,
  readIdentityEvents,
  rebuildRegistry,
  buildPromotion,
  buildConfirm,
  buildRosterClose,
  buildRosterReopen,
  pairKey,
  type SeatSignal,
  type IdentityEvent,
  type ChainedIdentityEvent,
  type Attestation,
  type AuthorityInput,
} from "../src/identity-binding.js";

const AT = "2026-07-12T00:00:00.000Z";
const SUBJECT = "principal:kyle"; // authenticated accountability scope (binding-key scope)

const perSeat = (ref: string): SeatSignal => ({ opaque_ref: ref, namespace: "oauth", lifetime: "cross_session", uniqueness_scope: "seat", assurance: "per_seat_credential" });
const sharedCred = (ref: string): SeatSignal => ({ opaque_ref: ref, namespace: "oauth", lifetime: "cross_session", uniqueness_scope: "credential" });
const sessionOnly = (ref: string): SeatSignal => ({ opaque_ref: ref, namespace: "conn", lifetime: "session", uniqueness_scope: "seat" });

const ATTESTED: Attestation = { standing: "attested", evidence_kind: "oauth_principal" };
const UNATTESTED: Attestation = { standing: "none" };
// Authority axis (authorization) — policy-supplied, INDEPENDENT of authentication.
const AUTH_GRANTED: AuthorityInput = { standing: "granted", authority_root: SUBJECT, grant_ref: "policy:hosted-owner" };
const AUTH_CONTRIB: AuthorityInput = { standing: "contribution_only" };
const AUTH_NONE: AuthorityInput = { standing: "none" };

// Common evaluate() inputs: an authenticated owner seat (subject scope = SUBJECT).
const owner = (extra: Partial<Parameters<typeof evaluateContact>[0]>) => ({ attestation: ATTESTED, authority: AUTH_GRANTED, subjectRoot: SUBJECT, at: AT, ...extra });

function chain(events: IdentityEvent[]): ChainedIdentityEvent[] {
  let prev = "";
  return events.map((e, i) => {
    const base = buildIdentityEvent(e);
    const hash = chainHash(base, i, prev);
    const rec: ChainedIdentityEvent = { ...base, seq: i, prev_hash: prev, hash };
    prev = hash;
    return rec;
  });
}

// ── seat_signal → seat_handle promotion ──────────────────────────────────────────────────────────────
test("isDurableSeatHandle: ONLY uniqueness_scope=seat AND cross_session qualifies", () => {
  assert.equal(isDurableSeatHandle(perSeat("a")), true);
  assert.equal(isDurableSeatHandle(sharedCred("a")), false);
  assert.equal(isDurableSeatHandle(sessionOnly("a")), false);
  assert.equal(isDurableSeatHandle(null), false);
});

test("normalizeToken + bindingKey: case/space-insensitive; key scoped by subject+namespace+ref", () => {
  assert.equal(normalizeToken("  Claude-Web "), "claude-web");
  assert.notEqual(bindingKey("principal:kyle", "oauth", "r1"), bindingKey("subject:agent", "oauth", "r1"));
});

// ── durable seat → bind → reuse → divergence hard-reject ─────────────────────────────────────────────
test("durable seat + attestation first contact BINDS under the subject scope", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { family: "claude", surface: "claude-web" }, signal: perSeat("seatA"), ...owner({}) });
  assert.equal(d.action, "bind");
  assert.equal(d.standing.origin, "bound");
  assert.equal(d.event?.kind, "identity_bound");
  assert.equal(d.event?.subject_root, SUBJECT);
});

test("repeat with the SAME identity REUSES; model/instance vary freely", () => {
  const log = chain([evaluateContact({ projection: projectBindings([]), declared: { family: "claude", surface: "claude-web", model: "opus", instance: "s1" }, signal: perSeat("seatA"), ...owner({}) }).event!]);
  const d = evaluateContact({ projection: projectBindings(log), declared: { family: "claude", surface: "claude-web", model: "sonnet", instance: "s2" }, signal: perSeat("seatA"), ...owner({}) });
  assert.equal(d.action, "reuse");
  assert.equal(d.event, null);
});

test("a DIVERGENT family/surface on a bound seat is HARD-REJECTED", () => {
  const log = chain([evaluateContact({ projection: projectBindings([]), declared: { family: "claude", surface: "claude-cowork" }, signal: perSeat("seatA"), ...owner({}) }).event!]);
  const d = evaluateContact({ projection: projectBindings(log), declared: { family: "claude", surface: "claude-desktop" }, signal: perSeat("seatA"), ...owner({}) });
  assert.equal(d.action, "reject_divergence");
  assert.equal(d.reject?.code, "IDENTITY_DIVERGENCE");
  assert.equal(d.event?.attempted_surface, "claude-desktop");
  assert.equal(d.event?.surface, "claude-cowork");
});

// ── shared-credential negative ───────────────────────────────────────────────────────────────────────
test("two surfaces behind ONE shared credential are BOTH provisional, never two hard seats", () => {
  const log: IdentityEvent[] = [];
  const a = evaluateContact({ projection: projectBindings(log), declared: { surface: "claude-web" }, signal: sharedCred("shared"), ...owner({}) });
  log.push(a.event!);
  const b = evaluateContact({ projection: projectBindings(log), declared: { surface: "claude-desktop" }, signal: sharedCred("shared"), ...owner({}) });
  assert.equal(a.action, "provisional");
  assert.equal(b.action, "provisional");
  assert.equal(b.reject, null);
});

test("a per-session-only signal stays provisional (cannot close cross-session drift)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: sessionOnly("s"), ...owner({}) });
  assert.equal(d.action, "provisional");
});

// ── the four axes are INDEPENDENT; authenticated ≠ granted ───────────────────────────────────────────
test("crossed-axis: bound origin + authority=NONE (durable autonomous seat, no canonical grant)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { family: "acme", surface: "acme-bot" }, signal: perSeat("botSeat"), attestation: { standing: "attested", evidence_kind: "per_seat_credential" }, authority: AUTH_NONE, subjectRoot: "subject:acme-bot", at: AT });
  assert.equal(d.standing.origin, "bound", "origin is driven by attestation+handle, not authority");
  assert.equal(d.standing.authentication.standing, "attested");
  assert.equal(d.standing.authority.standing, "none", "authenticated ≠ granted — no authority downgrade of origin");
  assert.equal(d.event?.subject_root, "subject:acme-bot");
});

test("crossed-axis: attested principal with NO grant ⇒ authority=contribution_only (not granted)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: sharedCred("shared"), attestation: ATTESTED, authority: AUTH_CONTRIB, subjectRoot: SUBJECT, at: AT });
  assert.equal(d.standing.authentication.standing, "attested");
  assert.equal(d.standing.authority.standing, "contribution_only", "authentication succeeding does NOT grant authority");
  assert.equal(d.standing.authority.grant_ref, null);
});

test("crossed-axis: unverified origin + contribution-only (unattested declared actor)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "newcomer" }, signal: null, attestation: UNATTESTED, authority: AUTH_CONTRIB, subjectRoot: null, at: AT });
  assert.equal(d.standing.origin, "unverified", "no attestation ⇒ origin unverified regardless of lane acceptance");
  assert.equal(d.standing.authentication.standing, "none");
  assert.equal(d.reject, null, "recorded, visible, not rejected");
});

test("crossed-axis: provisional origin + ATTESTED (weak but authenticated seat)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: sharedCred("shared"), attestation: ATTESTED, authority: AUTH_GRANTED, subjectRoot: SUBJECT, at: AT });
  assert.equal(d.standing.origin, "provisional");
  assert.equal(d.standing.authentication.standing, "attested");
});

test("granted authority is REPORTED but never scopes the binding key (key uses the subject)", () => {
  // Same subject, same seat ref, but different authority grant_ref ⇒ SAME binding key (reuse), because the
  // key is scoped by subject, not by the authority grant.
  const log = chain([evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("seatA"), attestation: ATTESTED, authority: AUTH_GRANTED, subjectRoot: SUBJECT, at: AT }).event!]);
  const d = evaluateContact({ projection: projectBindings(log), declared: { surface: "claude-web" }, signal: perSeat("seatA"), attestation: ATTESTED, authority: { standing: "granted", authority_root: SUBJECT, grant_ref: "policy:other" }, subjectRoot: SUBJECT, at: AT });
  assert.equal(d.action, "reuse", "authority grant does not fork the seat identity");
});

// ── Owner resolution: confirmed roster + policy freeze ────────────────────────────────────────────────
const contact = (surface: string, family: string, log: IdentityEvent[], signal: SeatSignal | null = null) =>
  evaluateContact({ projection: projectBindings(log), declared: { surface, family }, signal, attestation: ATTESTED, authority: AUTH_GRANTED, subjectRoot: SUBJECT, at: AT });

test("roster: an owner-CONFIRMED surface+family ⇒ origin `confirmed` (authority-vouched, NOT bound)", () => {
  const log = [buildConfirm({ subject_root: SUBJECT, surface: "claude-mobile", family: "claude", grant_ref: "policy:hosted-owner", at: AT })];
  const d = contact("claude-mobile", "claude", log);
  assert.equal(d.action, "confirmed");
  assert.equal(d.standing.origin, "confirmed", "confirmed is distinct from bound");
  assert.notEqual(d.standing.origin, "bound");
  assert.equal(d.standing.roster_policy, "open");
  assert.equal(d.event, null, "a confirmed match writes no new fact");
});

test("roster: a NOVEL surface under an OPEN roster ⇒ provisional (visible, from-nothing friendly)", () => {
  const log = [buildConfirm({ subject_root: SUBJECT, surface: "claude-mobile", family: "claude", grant_ref: "g", at: AT })];
  const d = contact("brand-new-surface", "claude", log);
  assert.equal(d.action, "provisional");
  assert.equal(d.standing.roster_policy, "open");
  assert.equal(d.reject, null);
});

test("roster: after owner CLOSE, a novel surface is a ROSTER rejection (not IDENTITY_DIVERGENCE); confirmed still ok", () => {
  const log = [
    buildConfirm({ subject_root: SUBJECT, surface: "claude-mobile", family: "claude", grant_ref: "g", at: AT }),
    buildRosterClose({ subject_root: SUBJECT, grant_ref: "g", roster_hash: "h", at: AT }),
  ];
  const novel = contact("claude-desktop", "claude", log);
  assert.equal(novel.action, "reject_roster");
  assert.equal(novel.reject?.code, "IDENTITY_ROSTER_REJECTED", "a policy rejection, NOT a seat divergence");
  assert.equal(novel.event?.kind, "identity_roster_rejected");
  assert.equal(novel.standing.roster_policy, "closed");
  const confirmed = contact("claude-mobile", "claude", log);
  assert.equal(confirmed.action, "confirmed", "a confirmed surface still passes under a closed roster");
});

test("roster: REOPEN re-admits novel surfaces (append-only; new/small agents stay possible, no history rewrite)", () => {
  const log = [
    buildConfirm({ subject_root: SUBJECT, surface: "claude-mobile", family: "claude", grant_ref: "g", at: AT }),
    buildRosterClose({ subject_root: SUBJECT, grant_ref: "g", roster_hash: "h", at: AT }),
    buildRosterReopen({ subject_root: SUBJECT, grant_ref: "g", at: AT }),
  ];
  const d = contact("newcomer", "claude", log);
  assert.equal(d.action, "provisional", "reopened roster admits a fresh provisional again");
  assert.equal(d.standing.roster_policy, "open");
});

test("roster: keyed by SUBJECT — another subject's close never leaks (workspace isolation via subject)", () => {
  const log = [
    buildConfirm({ subject_root: "principal:alice", surface: "a-surface", family: "acme", grant_ref: "g", at: AT }),
    buildRosterClose({ subject_root: "principal:alice", grant_ref: "g", roster_hash: "h", at: AT }),
  ];
  // A DIFFERENT subject (kyle) with no roster is unaffected by alice's closure.
  const d = contact("anything", "claude", log);
  assert.equal(d.action, "provisional");
  assert.equal(d.standing.roster_policy, null, "no roster for this subject ⇒ null policy, not alice's closed");
});

test("roster: canonicalization is on the PAIR — same surface, different family is NOT a confirmed match", () => {
  const log = [buildConfirm({ subject_root: SUBJECT, surface: "claude-web", family: "claude", grant_ref: "g", at: AT })];
  assert.equal(contact("claude-web", "claude", log).action, "confirmed");
  assert.equal(contact("claude-web", "gpt", log).action, "provisional", "surface+family pair, not surface alone");
  assert.equal(pairKey("Claude-Web", "Claude"), pairKey("claude-web", "claude"));
});

// ── Transition precision ─────────────────────────────────────────────────────────────────────────────
test("transitions: bound requires a durable handle; illegal transitions are refused", () => {
  assert.equal(isLegalTransition("provisional", "confirmed", false), true);
  assert.equal(isLegalTransition("confirmed", "bound", false), false);
  assert.equal(isLegalTransition("confirmed", "bound", true), true);
  assert.equal(isLegalTransition("bound", "provisional", true), false);
});

test("buildPromotion: legal transition ⇒ typed ok+event with from/to+subject; illegal ⇒ typed reject (not null)", () => {
  const r = buildPromotion({ from: "confirmed", to: "bound", hasDurableHandle: true, at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "r", family: "claude", surface: "claude-web" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.event.kind, "identity_promoted");
  assert.equal(r.event.from_standing, "confirmed");
  assert.equal(r.event.to_standing, "bound");
  assert.equal(r.event.subject_root, SUBJECT);
  const bad = buildPromotion({ from: "confirmed", to: "bound", hasDurableHandle: false, at: AT });
  assert.equal(bad.ok, false, "an illegal transition is a typed rejection, not a silently-ignored null");
  assert.match((bad as { reason: string }).reason, /durable seat handle/);
});

// ── hash-chained integrity + rebuild ─────────────────────────────────────────────────────────────────
test("a well-formed chain verifies; tampering ANY field breaks it; reorder breaks it", () => {
  const events = chain([
    { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-web", origin_standing: "bound" },
    { kind: "identity_provisional", at: AT, surface: "x", origin_standing: "provisional" },
  ]);
  assert.equal(verifyIdentityChain(events).ok, true);
  const tampered = structuredClone(events);
  tampered[0].surface = "claude-desktop";
  assert.equal(verifyIdentityChain(tampered).ok, false);
  assert.equal(verifyIdentityChain([events[1], events[0]] as ChainedIdentityEvent[]).ok, false);
});

test("two different canonical binds for one seat key are a CONFLICT ⇒ evaluateContact fails closed", () => {
  const log = chain([
    { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-web", origin_standing: "bound" },
    { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-desktop", origin_standing: "bound" },
  ]);
  const proj = projectBindings(log);
  assert.equal(proj.conflicts.length, 1);
  const d = evaluateContact({ projection: proj, declared: { family: "claude", surface: "claude-web" }, signal: perSeat("seatA"), ...owner({}) });
  assert.equal(d.reject?.code, "IDENTITY_BIND_CONFLICT");
});

test("append→read→verify round trip on disk, and rebuildRegistry FAILS CLOSED on a corrupted log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-idlog-"));
  try {
    await appendIdentityEvent(dir, { kind: "identity_bound", at: AT, subject_root: SUBJECT, namespace: "oauth", opaque_seat_ref: "seatA", family: "claude", surface: "claude-web", origin_standing: "bound" });
    await appendIdentityEvent(dir, { kind: "identity_provisional", at: AT, surface: "y", origin_standing: "provisional" });
    const events = await readIdentityEvents(dir);
    assert.equal(events.length, 2);
    assert.equal(events[1].prev_hash, events[0].hash);
    assert.equal(verifyIdentityChain(events).ok, true);
    assert.equal((await rebuildRegistry(dir)).binds.size, 1);
    const file = path.join(dir, ".gcl", "identity-events.jsonl");
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, raw.replace("claude-web", "claude-desktop"), "utf8");
    await assert.rejects(() => rebuildRegistry(dir), /integrity broken/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("no-secrets: identity events carry only the opaque_ref, never a raw credential", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("opaque-abc123"), ...owner({}) });
  assert.equal(d.event?.opaque_seat_ref, "opaque-abc123");
});

// ── Mediation/channel axis — HONEST standing ─────────────────────────────────────────────────────────
// A static-config or declared relay MUST NOT be presented as connection-verified: a known-false stamped
// field is worse than an explicit unknown. The floor is never higher than "declared"; only a caller that
// actually observed the transport may claim "observed".
test("mediation: no relay ⇒ 'unknown' with null evidence (an explicit unknown, never a false stamp)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("seatM1"), ...owner({}) });
  assert.deepEqual(d.standing.mediation, { relay: null, standing: "unknown", evidence_kind: null });
});

test("mediation: a relay with no substrate observation defaults to 'declared' (static vendor config is NOT verified)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("seatM2"), ...owner({ mediation: { relay: "hosted-oauth", evidence_kind: "static_config" } }) });
  assert.deepEqual(d.standing.mediation, { relay: "hosted-oauth", standing: "declared", evidence_kind: "static_config" });
});

test("mediation: 'observed' is honored ONLY when the caller asserts it (the substrate actually saw the transport)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("seatM3"), ...owner({ mediation: { relay: "wss-edge", standing: "observed", evidence_kind: "tls_sni" } }) });
  assert.equal(d.standing.mediation.standing, "observed");
  assert.equal(d.standing.mediation.relay, "wss-edge");
});

test("mediation: a null relay forces 'unknown' even if 'observed' is passed (no channel ⇒ nothing to verify)", () => {
  const d = evaluateContact({ projection: projectBindings([]), declared: { surface: "claude-web" }, signal: perSeat("seatM4"), ...owner({ mediation: { relay: null, standing: "observed" } }) });
  assert.equal(d.standing.mediation.standing, "unknown");
  assert.equal(d.standing.mediation.relay, null);
});
