import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveLedgerDir, sha256Text } from "./ledger.js";

/**
 * Identity binding — the ACCOUNTABILITY-FACT layer.
 *
 * Core defines: (1) the FOUR-AXIS standing model (origin / authentication / authority / mediation),
 * graded INDEPENDENTLY so a reader never infers more than the substrate knows; (2) the append-only,
 * HASH-CHAINED identity-event lane with integrity verification + deterministic rebuild (an audited
 * chain, not an unverifiable sidecar); (3) the projection that rebuilds the canonical binding registry
 * from the verified chain and FAILS CLOSED on conflicting binds or a broken chain. A connector owns the
 * transport-specific seat_signal ADAPTER and any materialized index — both derivable/verifiable from
 * THIS chain.
 *
 * Invariants:
 *  · A credential is a seat SIGNAL, not automatically a seat HANDLE — it hard-binds one actor ONLY when
 *    the issuer asserts per-seat uniqueness across sessions (isDurableSeatHandle).
 *  · Origin standing is driven by ATTESTATION + durable binding, NEVER by whether an authority grant
 *    exists. Authority, authentication, and mediation are separate axes.
 *  · A human principal is NOT universal — an autonomous subject may be its own authority root.
 *  · NO SECRETS are ever recorded: only opaque/pseudonymous refs. Core reads no wall clock (caller supplies `at`).
 */

// ── Standing axes (graded independently; never over-claimed) ─────────────────────────────────────────
export const ORIGIN_STANDINGS = ["bound", "confirmed", "provisional", "unverified"] as const;
export type OriginStanding = (typeof ORIGIN_STANDINGS)[number];

/** authentication axis: is there substrate evidence binding the caller, and of what kind. */
export const AUTHENTICATION_STANDINGS = ["attested", "none"] as const;
export type AuthenticationStanding = (typeof AUTHENTICATION_STANDINGS)[number];

/** authority axis: what grant/policy permitted the act. Extensible — a human principal is one
 *  projection; an autonomous subject or a contribution lane are others. Kept as a string, not a locked enum. */
export type AuthorityStanding = string; // e.g. "principal" | "autonomous_subject" | "contribution_only" | "none"

/** mediation/channel axis: HOW the relay/mediator value was determined. A relay that is static vendor
 *  configuration or a payload declaration MUST NOT be presented as connection-verified — a known-false
 *  stamped field is worse than an explicit unknown. "observed" is reserved for a relay the substrate
 *  directly saw on the transport; a config/declared relay is "declared"; no relay is "unknown". This is
 *  an axis-local evidence descriptor (like authentication's), NOT a parallel global standing enum. */
export const MEDIATION_STANDINGS = ["observed", "declared", "unknown"] as const;
export type MediationStanding = (typeof MEDIATION_STANDINGS)[number];

export interface Attestation {
  standing: AuthenticationStanding;
  /** What kind of evidence (e.g. "oauth_principal", "per_seat_credential", "none"). */
  evidence_kind?: string | null;
}
export interface AuthorityInput {
  standing: AuthorityStanding;
  /** Opaque authority-root scoping id (e.g. "principal:kyle", "subject:agent-x"). NEVER a secret. */
  authority_root?: string | null;
  grant_ref?: string | null;
}

/** The full four-axis standing, reported per-request. Each axis is independent. */
export interface StandingSet {
  origin: OriginStanding;
  authentication: { standing: AuthenticationStanding; evidence_kind: string | null };
  authority: { standing: AuthorityStanding; authority_root: string | null; grant_ref: string | null };
  /** mediation/channel axis — the relay value PLUS its honest standing. A static-config or declared
   *  relay is graded "declared" (never verified); no relay is "unknown". Readers see the value AND how it was known. */
  mediation: { relay: string | null; standing: MediationStanding; evidence_kind: string | null };
  /** The subject's confirmed-surface ROSTER policy — exposed SEPARATELY from origin standing: a closed
   *  roster is a policy freeze, never technical proof. null when the subject has no roster. */
  roster_policy: "open" | "closed" | null;
}

// ── Seat signal — what the substrate INDEPENDENTLY observes about the seat (NEVER from payload) ───────
export const UNIQUENESS_SCOPES = ["seat", "credential", "principal", "none"] as const;
export type UniquenessScope = (typeof UNIQUENESS_SCOPES)[number];
export const SEAT_LIFETIMES = ["session", "cross_session"] as const;
export type SeatLifetime = (typeof SEAT_LIFETIMES)[number];

export interface SeatSignal {
  /** Opaque/pseudonymous reference — NEVER a raw key/cert/token or reversible fingerprint. */
  opaque_ref: string;
  /** Issuer/transport namespace, so refs from different issuers never collide. */
  namespace: string;
  /** A durable seat_handle requires cross_session; a per-session signal only isolates concurrent seats. */
  lifetime: SeatLifetime;
  /** What the issuer guarantees the ref uniquely identifies. ONLY "seat" can hard-bind a single actor. */
  uniqueness_scope: UniquenessScope;
  assurance?: string | null;
}

/** A signal is a durable seat_handle ONLY when unique per seat AND cross-session. */
export function isDurableSeatHandle(s: SeatSignal | null | undefined): boolean {
  return !!s && s.uniqueness_scope === "seat" && s.lifetime === "cross_session";
}

// ── Declared origin — what the actor CLAIMS (from the payload envelope) ───────────────────────────────
export interface DeclaredOrigin {
  family?: string | null;   // grouping (bare model-family legit); pinned WITH surface on a bound seat
  surface?: string | null;  // the canonical routing identity; pinned on a bound seat
  model?: string | null;    // provenance only — free to vary; NEVER a divergence trigger
  instance?: string | null; // ephemeral session isolation — NEVER canonical; its change is not a divergence
}

export function normalizeToken(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/** Scoped binding key: authority_root + issuer namespace + opaque seat ref. A raw ref is NEVER globally
 *  trusted — it only means something within its (authority_root, namespace). */
export function bindingKey(authorityRoot: string | null | undefined, namespace: string, opaqueRef: string): string {
  return [authorityRoot ?? "", namespace, opaqueRef].join(" ");
}

// ── Standing transitions ─────────────────────────────────────────────────────────────────────────────
/** Legal origin-standing transitions. A rise to `bound` ALWAYS requires a durable handle; `confirmed`
 *  (human/policy canonicalization) can only precede `bound` when a durable handle is then provisioned —
 *  naming alone must never imply confirmation manufactured technical correlation. */
export const LEGAL_TRANSITIONS: Record<OriginStanding, OriginStanding[]> = {
  unverified: ["provisional", "confirmed", "bound"],
  provisional: ["confirmed", "bound"],
  confirmed: ["bound"],
  bound: [],
};
export function isLegalTransition(from: OriginStanding, to: OriginStanding, hasDurableHandle: boolean): boolean {
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) return false;
  if (to === "bound") return hasDurableHandle; // bound is a technical correlation — requires a durable handle
  return true;
}

// ── Identity events — append-only accountability facts (NO secrets) ───────────────────────────────────
export const IDENTITY_EVENT_KINDS = [
  "identity_bound",               // a durable seat_handle pinned canonical family+surface
  "identity_provisional",         // recorded, not bound (origin_standing carries provisional|unverified)
  "identity_confirmed",           // authority canonicalized a declared surface+family for a subject (roster add) — NO technical correlation
  "identity_promoted",            // an explicit standing transition (carries from_standing/to_standing)
  "identity_divergence_rejected", // a bound seat declared a divergent canonical family/surface — refused
  "identity_roster_closed",       // owner FROZE a subject's confirmed-surface roster (policy freeze, not a technical bind)
  "identity_roster_reopened",     // owner reopened a frozen roster (append-only; new/small agents stay possible)
  "identity_roster_rejected",     // a novel surface refused under a CLOSED roster — policy rejection, NOT a seat divergence
] as const;
export type IdentityEventKind = (typeof IDENTITY_EVENT_KINDS)[number];

export interface IdentityEvent {
  kind: IdentityEventKind;
  at: string; // ISO-8601 (caller-supplied; core stamps no wall clock)
  /** The authenticated accountability/SUBJECT scope the binding key is scoped by (e.g. "principal:kyle").
   *  This is identity scoping derived from AUTHENTICATION — NOT an authorization grant (authenticated ≠ authorized). */
  subject_root?: string;
  /** Authority AXIS (authorization) — policy-supplied, independent of authentication. */
  authority_root?: string;
  authority_standing?: string;
  grant_ref?: string;
  authentication_standing?: AuthenticationStanding;
  evidence_kind?: string;
  namespace?: string;
  opaque_seat_ref?: string;
  family?: string;
  surface?: string;
  model?: string;
  instance?: string;
  origin_standing: OriginStanding;
  /** Explicit transition endpoints — set on identity_promoted / identity_confirmed. */
  from_standing?: OriginStanding;
  to_standing?: OriginStanding;
  /** For identity_divergence_rejected / identity_roster_rejected: the declaration that was refused. */
  attempted_family?: string;
  attempted_surface?: string;
  /** For identity_roster_closed: a hash of the confirmed-set at freeze time (auditability). */
  roster_hash?: string;
  reason?: string;
}

/** A chained record as persisted: the event plus its integrity fields. */
export interface ChainedIdentityEvent extends IdentityEvent {
  seq: number;
  prev_hash: string;
  hash: string;
}

const IDENTITY_EVENTS_FILE = "identity-events.jsonl";
const GENESIS_PREV = ""; // the chain root's prev_hash

/** The append-only, hash-chained identity lane lives beside the ledger (`.gcl/`). */
export function identityEventsPath(root: string): string {
  return path.join(root, resolveLedgerDir(root), IDENTITY_EVENTS_FILE);
}

/** Build a sparse identity event, dropping absent optional fields. */
export function buildIdentityEvent(input: IdentityEvent): IdentityEvent {
  const rec: IdentityEvent = { kind: input.kind, at: input.at, origin_standing: input.origin_standing };
  const bag = rec as unknown as Record<string, unknown>;
  const putStr = (k: keyof IdentityEvent, v: unknown): void => {
    if (typeof v === "string" && v.trim()) bag[k as string] = v.trim();
  };
  putStr("subject_root", input.subject_root);
  putStr("authority_root", input.authority_root);
  putStr("authority_standing", input.authority_standing);
  putStr("grant_ref", input.grant_ref);
  putStr("evidence_kind", input.evidence_kind);
  putStr("namespace", input.namespace);
  putStr("opaque_seat_ref", input.opaque_seat_ref);
  putStr("family", input.family);
  putStr("surface", input.surface);
  putStr("model", input.model);
  putStr("instance", input.instance);
  putStr("attempted_family", input.attempted_family);
  putStr("attempted_surface", input.attempted_surface);
  putStr("roster_hash", input.roster_hash);
  putStr("reason", input.reason);
  if (input.authentication_standing) rec.authentication_standing = input.authentication_standing;
  if (input.from_standing) rec.from_standing = input.from_standing;
  if (input.to_standing) rec.to_standing = input.to_standing;
  return rec;
}

/** Deterministic (key-sorted) serialization for the integrity hash — the same idiom the revision chain
 *  uses (stable stringify + sha256Text). Records are flat, so a top-level key sort is canonical. */
function stableStringify(o: Record<string, unknown>): string {
  return JSON.stringify(o, Object.keys(o).sort());
}
/** The chain hash covers the event body + its position (seq) + the prior record's hash. */
export function chainHash(event: IdentityEvent, seq: number, prevHash: string): string {
  return sha256Text(stableStringify({ ...(event as unknown as Record<string, unknown>), seq, prev_hash: prevHash }));
}

/** Append an identity event as the next link in the hash chain. Reads the current tail to derive
 *  seq + prev_hash (the connector serializes appends, like the ledger lock). Returns the chained record. */
export async function appendIdentityEvent(root: string, event: IdentityEvent): Promise<ChainedIdentityEvent> {
  const file = identityEventsPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await readIdentityEvents(root);
  const prev = existing[existing.length - 1];
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_PREV;
  const base = buildIdentityEvent(event);
  const hash = chainHash(base, seq, prevHash);
  const chained: ChainedIdentityEvent = { ...base, seq, prev_hash: prevHash, hash };
  await fs.appendFile(file, JSON.stringify(chained) + "\n", "utf8");
  return chained;
}

/** Read the full chained identity log (oldest first); empty when the log does not exist. */
export async function readIdentityEvents(root: string): Promise<ChainedIdentityEvent[]> {
  try {
    const raw = await fs.readFile(identityEventsPath(root), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as ChainedIdentityEvent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Walk the chain and verify integrity: monotonic seq from 0, each prev_hash links the prior record, and
 *  each hash recomputes over the record body. Returns the first broken index (or -1 = intact). Detects
 *  tampering, reordering, insertion, and truncation-in-the-middle. */
export function verifyIdentityChain(events: ChainedIdentityEvent[]): { ok: boolean; brokenAt: number } {
  let prevHash = GENESIS_PREV;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) return { ok: false, brokenAt: i };
    if (e.prev_hash !== prevHash) return { ok: false, brokenAt: i };
    const { seq, prev_hash, hash, ...body } = e;
    if (chainHash(body as IdentityEvent, seq, prev_hash) !== hash) return { ok: false, brokenAt: i };
    prevHash = e.hash;
  }
  return { ok: true, brokenAt: -1 };
}

// ── Projection: rebuild the canonical registry from the VERIFIED chain; fail closed on conflicts ──────
export interface CanonicalBind {
  key: string;
  /** The authenticated accountability/subject scope this seat is bound under (NOT an authorization grant). */
  subject_root: string | null;
  namespace: string;
  opaque_seat_ref: string;
  family: string | null;
  surface: string | null;
  standing: OriginStanding;
  bound_at: string;
}
/** A subject's confirmed-surface roster — SUBJECT-scoped policy for weak transports, distinct from the
 *  seat-scoped `binds`. `closed` freezes it: a novel surface is then a policy rejection. */
export interface SubjectRoster {
  /** confirmed (surface+family) pairs, keyed by pairKey. */
  pairs: Map<string, { surface: string | null; family: string | null }>;
  closed: boolean;
}
export interface BindingProjection {
  binds: Map<string, CanonicalBind>;
  /** Keys where the log recorded two different canonical (family,surface) binds — the registry MUST fail
   *  closed for these. */
  conflicts: string[];
  /** Per-subject confirmed-surface roster + freeze policy (weak-transport enforcement). */
  rosters: Map<string, SubjectRoster>;
}

/** Canonical key for a (surface, family) pair — both normalized, so divergence/membership compare the PAIR,
 *  never surface alone. */
export function pairKey(surface: string | null | undefined, family: string | null | undefined): string {
  return `${normalizeToken(surface) ?? ""} ${normalizeToken(family) ?? ""}`;
}

/** Fold the identity log into the canonical registry. Only identity_bound / identity_promoted-to-bound
 *  establish a canonical bind; a second, different one for the same key is a conflict. */
export function projectBindings(events: IdentityEvent[]): BindingProjection {
  const binds = new Map<string, CanonicalBind>();
  const conflicts = new Set<string>();
  const rosters = new Map<string, SubjectRoster>();
  const rosterFor = (subject: string): SubjectRoster => {
    let r = rosters.get(subject);
    if (!r) { r = { pairs: new Map(), closed: false }; rosters.set(subject, r); }
    return r;
  };
  for (const e of events) {
    const becomesBound = e.kind === "identity_bound" || (e.kind === "identity_promoted" && (e.to_standing ?? e.origin_standing) === "bound");
    if (becomesBound) {
      if (!e.namespace || !e.opaque_seat_ref) continue;
      const key = bindingKey(e.subject_root ?? null, e.namespace, e.opaque_seat_ref);
      const family = normalizeToken(e.family);
      const surface = normalizeToken(e.surface);
      const existing = binds.get(key);
      if (existing) {
        if (existing.family !== family || existing.surface !== surface) conflicts.add(key);
        continue;
      }
      binds.set(key, { key, subject_root: e.subject_root ?? null, namespace: e.namespace, opaque_seat_ref: e.opaque_seat_ref, family, surface, standing: "bound", bound_at: e.at });
      continue;
    }
    // Subject-scoped confirmed roster (weak-transport policy): confirm adds a pair; close/reopen flip the freeze.
    if (!e.subject_root) continue;
    if (e.kind === "identity_confirmed") rosterFor(e.subject_root).pairs.set(pairKey(e.surface, e.family), { surface: normalizeToken(e.surface), family: normalizeToken(e.family) });
    else if (e.kind === "identity_roster_closed") rosterFor(e.subject_root).closed = true;
    else if (e.kind === "identity_roster_reopened") rosterFor(e.subject_root).closed = false;
  }
  return { binds, conflicts: [...conflicts], rosters };
}

/** Read + VERIFY the chain, then project. FAILS CLOSED (throws) on a broken chain so a materialized index
 *  can never be derived from a tampered log. */
export async function rebuildRegistry(root: string): Promise<BindingProjection> {
  const events = await readIdentityEvents(root);
  const v = verifyIdentityChain(events);
  if (!v.ok) throw new Error(`identity chain integrity broken at index ${v.brokenAt}; refusing to rebuild the binding registry (fail closed).`);
  return projectBindings(events);
}

// ── Contact evaluation — the automatic per-request decision, four axes reported independently ─────────
export type ContactAction = "bind" | "reuse" | "reject_divergence" | "provisional" | "confirmed" | "reject_roster";

export interface ContactDecision {
  action: ContactAction;
  /** All four axes, graded independently — NOT one enum inferred from authority. */
  standing: StandingSet;
  /** The identity event to append (null for a pure reuse — no new fact). */
  event: IdentityEvent | null;
  /** Present only for reject_divergence: the refusal for the caller to fail closed on. */
  reject: { code: string; message: string } | null;
  /** The scoped binding key when a seat signal was observed (else null). */
  key: string | null;
}

/**
 * Decide what one request's declared origin + observed seat signal + attestation + authority mean against
 * the current projection. Pure + deterministic. ORIGIN standing is driven by attestation + durable binding
 * ONLY; authority/authentication/mediation are reported as their own axes and never fold into origin.
 */
export function evaluateContact(input: {
  projection: BindingProjection;
  declared: DeclaredOrigin;
  signal: SeatSignal | null;
  attestation: Attestation;
  authority: AuthorityInput;
  /** The authenticated accountability/SUBJECT scope for the binding key (e.g. "principal:kyle"). Derived from
   *  AUTHENTICATION, NOT authorization — a bind is scoped to the accountable subject, never to a grant.
   *  null when unattested. */
  subjectRoot: string | null;
  /** Optional mediation/channel evidence. `standing` is the caller's honest grade of the relay's provenance —
   *  pass "observed" ONLY when the substrate directly saw the transport; a static-config/declared relay omits it
   *  and defaults to "declared". A null relay is always "unknown" regardless of what is passed. */
  mediation?: { relay?: string | null; standing?: MediationStanding; evidence_kind?: string | null };
  at: string;
}): ContactDecision {
  const { projection, declared, signal, attestation, authority, subjectRoot, mediation, at } = input;
  const family = normalizeToken(declared.family);
  const surface = normalizeToken(declared.surface);

  // The authority / authentication / mediation axes are independent of the origin outcome. The authority
  // axis is POLICY-supplied (authenticated ≠ granted); it is reported, never used to scope the binding key.
  const authAxis = { standing: authority.standing, authority_root: authority.authority_root ?? null, grant_ref: authority.grant_ref ?? null };
  const authnAxis = { standing: attestation.standing, evidence_kind: attestation.evidence_kind ?? null };
  // Mediation graded HONESTLY: a relay is NEVER auto-verified. No relay ⇒ "unknown"; a relay present
  // without an explicit substrate observation ⇒ "declared" (static config / payload), never "observed". Only a
  // caller that actually saw the transport may assert "observed". Static vendor config can't masquerade as verified.
  const relay = mediation?.relay ?? null;
  const medAxis: StandingSet["mediation"] = relay === null
    ? { relay: null, standing: "unknown", evidence_kind: null }
    : { relay, standing: mediation?.standing ?? "declared", evidence_kind: mediation?.evidence_kind ?? null };
  const roster = subjectRoot ? projection.rosters.get(subjectRoot) ?? null : null;
  const rosterPolicy: "open" | "closed" | null = roster ? (roster.closed ? "closed" : "open") : null;
  const stand = (origin: OriginStanding): StandingSet => ({ origin, authentication: authnAxis, authority: authAxis, mediation: medAxis, roster_policy: rosterPolicy });

  const commonEventAxes = {
    subject_root: subjectRoot ?? undefined,
    authority_root: authority.authority_root ?? undefined,
    authority_standing: authority.standing,
    grant_ref: authority.grant_ref ?? undefined,
    authentication_standing: attestation.standing,
    evidence_kind: attestation.evidence_kind ?? undefined,
  };

  if (isDurableSeatHandle(signal) && attestation.standing === "attested") {
    const s = signal as SeatSignal;
    const key = bindingKey(subjectRoot, s.namespace, s.opaque_ref);
    if (projection.conflicts.includes(key)) {
      return { action: "reject_divergence", standing: stand("unverified"), event: null,
        reject: { code: "IDENTITY_BIND_CONFLICT", message: `seat has conflicting canonical binds on the ledger; refusing to route until resolved.` }, key };
    }
    const existing = projection.binds.get(key);
    if (!existing) {
      return { action: "bind", standing: stand("bound"),
        event: buildIdentityEvent({ kind: "identity_bound", at, ...commonEventAxes, namespace: s.namespace, opaque_seat_ref: s.opaque_ref,
          family: declared.family ?? undefined, surface: declared.surface ?? undefined, model: declared.model ?? undefined, instance: declared.instance ?? undefined,
          origin_standing: "bound", evidence_kind: attestation.evidence_kind ?? "per_seat_credential" }),
        reject: null, key };
    }
    if (existing.family === family && existing.surface === surface) {
      return { action: "reuse", standing: stand("bound"), event: null, reject: null, key };
    }
    return { action: "reject_divergence", standing: stand("bound"), // the SEAT stays bound; the divergent CLAIM is refused
      event: buildIdentityEvent({ kind: "identity_divergence_rejected", at, ...commonEventAxes, namespace: s.namespace, opaque_seat_ref: s.opaque_ref,
        family: existing.family ?? undefined, surface: existing.surface ?? undefined,
        attempted_family: declared.family ?? undefined, attempted_surface: declared.surface ?? undefined,
        origin_standing: "bound", reason: "declared family/surface diverges from the bound seat identity" }),
      reject: { code: "IDENTITY_DIVERGENCE", message: `declared identity diverges from this seat's bound identity (${existing.family ?? "?"}/${existing.surface ?? "?"}); refused.` }, key };
  }

  // No durable hard bind. An UNATTESTED caller is `unverified` regardless of any roster (no auth ⇒ the roster
  // can't vouch for it): recorded, visible, never canonical.
  const keyForSignal = signal ? bindingKey(subjectRoot, signal.namespace, signal.opaque_ref) : null;
  if (attestation.standing !== "attested") {
    return { action: "provisional", standing: stand("unverified"),
      event: buildIdentityEvent({ kind: "identity_provisional", at, ...commonEventAxes,
        namespace: signal?.namespace ?? undefined, opaque_seat_ref: signal?.opaque_ref ?? undefined,
        family: declared.family ?? undefined, surface: declared.surface ?? undefined, model: declared.model ?? undefined, instance: declared.instance ?? undefined,
        origin_standing: "unverified", evidence_kind: attestation.evidence_kind ?? (signal ? `non_seat_signal:${signal.uniqueness_scope}` : "declared") }),
      reject: null, key: keyForSignal };
  }

  // Attested but weak/no seat handle: the SUBJECT-scoped confirmed ROSTER governs.
  const pk = pairKey(surface, family);
  if (roster && roster.pairs.has(pk)) {
    // an owner-CONFIRMED surface+family for this subject → `confirmed` (authority-vouched, NOT a technical
    // seat bind; never collapse the two). No new fact: the confirmation already stands.
    return { action: "confirmed", standing: stand("confirmed"), event: null, reject: null, key: keyForSignal };
  }
  if (roster?.closed) {
    // Novel surface under a FROZEN roster ⇒ a POLICY rejection, NOT a seat divergence. The seat did not
    // technically diverge; the owner's roster policy refuses an unlisted surface.
    return { action: "reject_roster", standing: stand("provisional"),
      event: buildIdentityEvent({ kind: "identity_roster_rejected", at, ...commonEventAxes,
        attempted_surface: declared.surface ?? undefined, attempted_family: declared.family ?? undefined,
        origin_standing: "provisional", reason: "surface+family not in the subject's CLOSED confirmed roster (policy freeze)" }),
      reject: { code: "IDENTITY_ROSTER_REJECTED", message: `surface "${declared.surface ?? "?"}" is not in this subject's closed roster; refused by roster policy (not a seat divergence).` },
      key: keyForSignal };
  }
  // Open roster (or none): a fresh declaration participates at `provisional` — visible, from-nothing-friendly.
  return { action: "provisional", standing: stand("provisional"),
    event: buildIdentityEvent({ kind: "identity_provisional", at, ...commonEventAxes,
      namespace: signal?.namespace ?? undefined, opaque_seat_ref: signal?.opaque_ref ?? undefined,
      family: declared.family ?? undefined, surface: declared.surface ?? undefined, model: declared.model ?? undefined, instance: declared.instance ?? undefined,
      origin_standing: "provisional", evidence_kind: attestation.evidence_kind ?? (signal ? `non_seat_signal:${signal.uniqueness_scope}` : "declared") }),
    reject: null, key: keyForSignal };
}

/** A TYPED transition result: an illegal transition returns `{ok:false, reason}` — the command/runtime
 *  boundary emits an auditable rejection, never a silently-ignored null. */
export type PromotionResult = { ok: true; event: IdentityEvent } | { ok: false; reason: string };

/** Build an explicit standing transition. Naming never manufactures correlation: `to: "bound"` requires a
 *  durable handle (hasDurableHandle) — owner confirmation ALONE yields `confirmed`, never `bound`. */
export function buildPromotion(input: {
  from: OriginStanding;
  to: OriginStanding;
  hasDurableHandle: boolean;
  at: string;
  subject_root?: string | null;
  authority_root?: string | null;
  grant_ref?: string | null;
  namespace?: string | null;
  opaque_seat_ref?: string | null;
  family?: string | null;
  surface?: string | null;
  evidence_kind?: string | null;
  reason?: string | null;
}): PromotionResult {
  if (!isLegalTransition(input.from, input.to, input.hasDurableHandle)) {
    return { ok: false, reason: `illegal standing transition ${input.from}→${input.to}${input.to === "bound" && !input.hasDurableHandle ? " (bound requires a server-derived durable seat handle; confirmation alone is not correlation proof)" : ""}` };
  }
  const kind: IdentityEventKind = input.to === "confirmed" ? "identity_confirmed" : "identity_promoted";
  return { ok: true, event: buildIdentityEvent({
    kind, at: input.at, origin_standing: input.to, from_standing: input.from, to_standing: input.to,
    subject_root: input.subject_root ?? undefined,
    authority_root: input.authority_root ?? undefined, grant_ref: input.grant_ref ?? undefined,
    namespace: input.namespace ?? undefined, opaque_seat_ref: input.opaque_seat_ref ?? undefined,
    family: input.family ?? undefined, surface: input.surface ?? undefined,
    evidence_kind: input.evidence_kind ?? (input.to === "confirmed" ? "human_resolution" : undefined),
    reason: input.reason ?? undefined,
  }) };
}

/** Owner-resolution builders. All require a granted authority + its grant_ref at the command boundary
 *  (enforced by the caller); these just shape the append-only facts.
 *
 *  `buildConfirm` — canonicalize a surface+family for a subject (roster add) ⇒ `confirmed`. NEVER `bound`:
 *  owner confirmation is not technical correlation. A durable-handle promotion to `bound` goes through
 *  buildPromotion with server-derived proof, not here. */
export function buildConfirm(input: { subject_root: string; surface: string; family: string; grant_ref: string; at: string; authority_root?: string | null; reason?: string | null }): IdentityEvent {
  return buildIdentityEvent({
    kind: "identity_confirmed", at: input.at,
    subject_root: input.subject_root, surface: input.surface, family: input.family,
    grant_ref: input.grant_ref, authority_root: input.authority_root ?? undefined, authority_standing: "granted",
    origin_standing: "confirmed", evidence_kind: "human_resolution", reason: input.reason ?? undefined,
  });
}
/** `buildRosterClose` — freeze a subject's confirmed roster (policy freeze, NOT technical proof). */
export function buildRosterClose(input: { subject_root: string; grant_ref: string; roster_hash: string; at: string; authority_root?: string | null; reason?: string | null }): IdentityEvent {
  return buildIdentityEvent({
    kind: "identity_roster_closed", at: input.at, subject_root: input.subject_root,
    grant_ref: input.grant_ref, authority_root: input.authority_root ?? undefined, authority_standing: "granted",
    roster_hash: input.roster_hash, origin_standing: "confirmed", evidence_kind: "policy", reason: input.reason ?? undefined,
  });
}
/** `buildRosterReopen` — reopen a frozen roster (append-only; new/small agents stay possible). */
export function buildRosterReopen(input: { subject_root: string; grant_ref: string; at: string; authority_root?: string | null; reason?: string | null }): IdentityEvent {
  return buildIdentityEvent({
    kind: "identity_roster_reopened", at: input.at, subject_root: input.subject_root,
    grant_ref: input.grant_ref, authority_root: input.authority_root ?? undefined, authority_standing: "granted",
    origin_standing: "confirmed", evidence_kind: "policy", reason: input.reason ?? undefined,
  });
}
/** Deterministic hash of a subject's confirmed pairs (sorted) — recorded at freeze time for auditability. */
export function rosterHash(pairs: Iterable<string>): string {
  return sha256Text([...pairs].sort().join("\n"));
}
