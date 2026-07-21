import { GclLedger, LedgerError, STAMPED_FROM, type RevisionEnvelope, type ActionProvenance } from "./ledger.js";
import {
  readIdentityEvents,
  verifyIdentityChain,
  projectBindings,
  isLegalTransition,
  IDENTITY_EVENT_KINDS,
  ORIGIN_STANDINGS,
  type IdentityEvent,
} from "./identity-binding.js";

/**
 * Identity anchor. A self-contained hash chain (see identity-binding) misses VALID TAIL TRUNCATION and
 * risks a second "truth" beside the ledger: an attacker who drops the tail leaves a chain that still
 * verifies internally. Fix: on every accepted identity append, CAS-advance a canonical anchor —
 * `{identity_head_hash, identity_head_seq}` — INTO the existing revision chain as a content-addressed
 * artifact ref, carrying a DERIVED SYSTEM provenance envelope so the new integrity fact is itself
 * accountable and versioned. The anchor is a deterministic projection of the triggering identity event;
 * it does NOT claim the triggering subject authored the anchor revision.
 *
 * Recovery is AUDITABLE, never silent: a valid-but-unanchored tail (crash between append and anchor) is
 * re-anchored with a distinct RECOVERY revision only after the whole tail passes SEMANTIC validation
 * (schema, legal transitions, canonical-bind invariants) — a well-hashed but semantically invalid tail
 * fails closed. Readback distinguishes ok / recovered / degraded.
 */

const ANCHOR_LANE = "identity";
const ANCHOR_ARTIFACT = "identity-events.jsonl";
const ANCHOR_ACTOR = "gcl-identity-anchor";      // a declared SYSTEM/runtime component — never a mind or human
const ANCHOR_PRINCIPAL = "gcl-runtime";          // the host runtime that posts the integrity projection
const MAX_CAS_RETRIES = 8;

export interface IdentityHead { hash: string; seq: number; }
export interface AnchoredHead extends IdentityHead { recovery: boolean; }
export interface RecoveryContext { priorSeq: number | null; }

function anchorProvenance(head: IdentityHead, recovery?: RecoveryContext): ActionProvenance {
  const p: ActionProvenance = {
    principal_id: ANCHOR_PRINCIPAL,
    principal_source: "operator_local", // a host-runtime action, not a connector-mediated agent/human claim
    posted_by: ANCHOR_ACTOR,
    originated_by: ANCHOR_ACTOR,
    evidence_kind: "derived", // a deterministic integrity projection of the identity event, not original content
    origin_ref: `${ANCHOR_ARTIFACT}#${head.seq}:${head.hash}`, // the exact identity event that caused the advance
    authority_source: "protocol:identity-integrity-invariant", // runtime policy, NOT fabricated human authorization
    authority_scope: "workspace",
  };
  if (recovery) p.origin_excerpt = `recovery: prior_anchor_seq=${recovery.priorSeq ?? "none"} recovered_head_seq=${head.seq}`;
  return p;
}

function anchorEnvelope(parent: string, head: IdentityHead, at: string, recovery?: RecoveryContext): RevisionEnvelope {
  return {
    parent_revision: parent,
    commit_id: `${recovery ? "idanchor_recovery" : "idanchor"}_${head.seq}_${head.hash.slice(0, 12)}`,
    actor: ANCHOR_ACTOR,
    session: "identity-anchor",
    timestamp: at,
    artifacts: [{ path: `${ANCHOR_ARTIFACT}#${head.seq}`, lane: ANCHOR_LANE, hash: head.hash }],
    lanes: [ANCHOR_LANE],
    spaces_contract_version: null,
    schema_version: STAMPED_FROM, // provenance is folded into the revision_id at this schema version
    provenance: anchorProvenance(head, recovery),
  };
}

/** CAS-advance the canonical anchor to `head`. Pass `recovery` to stamp an auditable recovery revision.
 *  Retries on a concurrent non-identity commit (HEAD moved). */
export async function advanceIdentityAnchor(ledger: GclLedger, head: IdentityHead, at: string, recovery?: RecoveryContext): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const parent = await ledger.getHead();
    try {
      await ledger.finalizeRevision(parent, anchorEnvelope(parent, head, at, recovery));
      return;
    } catch (e) {
      if (e instanceof LedgerError && e.code === "CONFLICT") continue;
      throw e;
    }
  }
  throw new Error("identity anchor CAS retries exhausted (revision HEAD contention)");
}

/** The latest anchored identity head from REACHABLE revisions (null when never anchored). `recovery` marks
 *  an anchor that was written by the recovery path. */
export async function readIdentityAnchor(ledger: GclLedger): Promise<AnchoredHead | null> {
  const reachable = await ledger.readReachableRevisions(); // genesis → HEAD
  for (let i = reachable.length - 1; i >= 0; i--) {
    const rev = reachable[i];
    const art = rev.artifacts.find((a) => a.lane === ANCHOR_LANE && a.path.startsWith(`${ANCHOR_ARTIFACT}#`));
    if (art) {
      const seq = Number.parseInt(art.path.slice(art.path.indexOf("#") + 1), 10);
      if (Number.isInteger(seq)) return { hash: art.hash, seq, recovery: rev.commit_id.startsWith("idanchor_recovery") };
    }
  }
  return null;
}

/**
 * Semantic validation of the identity log: a well-hashed tail is not enough to promote to canonical truth.
 * Checks event schema (known kind + standing + required binding coordinates), legal standing transitions on
 * promotions/confirmations, and the canonical-bind invariant (no conflicting binds).
 */
export function validateIdentityLog(events: IdentityEvent[]): { valid: boolean; reason?: string } {
  const kinds = new Set<string>(IDENTITY_EVENT_KINDS);
  const standings = new Set<string>(ORIGIN_STANDINGS);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!kinds.has(e.kind)) return { valid: false, reason: `event ${i}: unknown kind "${e.kind}"` };
    if (!standings.has(e.origin_standing)) return { valid: false, reason: `event ${i}: invalid origin_standing "${e.origin_standing}"` };
    if (typeof e.at !== "string" || !e.at.trim()) return { valid: false, reason: `event ${i}: missing timestamp` };
    if (e.kind === "identity_bound" && (!e.subject_root || !e.namespace || !e.opaque_seat_ref)) {
      return { valid: false, reason: `event ${i}: bound event missing binding coordinates` };
    }
    if ((e.kind === "identity_promoted" || e.kind === "identity_confirmed") && e.from_standing && e.to_standing) {
      const hasHandle = !!(e.namespace && e.opaque_seat_ref);
      if (!isLegalTransition(e.from_standing, e.to_standing, e.to_standing === "bound" ? hasHandle : true)) {
        return { valid: false, reason: `event ${i}: illegal transition ${e.from_standing}→${e.to_standing}` };
      }
    }
  }
  if (projectBindings(events).conflicts.length) return { valid: false, reason: "conflicting canonical binds in the log" };
  return { valid: true };
}

export interface AnchorVerification {
  ok: boolean;
  /** ok = anchored + matched; recovered = anchored via a recovery revision; degraded = fails closed. */
  status: "ok" | "recovered" | "degraded";
  degraded?: string;
  /** True when the divergence is a merely-lagging anchor over an integrity-valid chain (caller may re-anchor
   *  after SEMANTIC validation). FALSE for the dangerous classes (truncation / mismatch / broken). */
  recoverable?: boolean;
}

/** Verify the identity lane reaches the anchored head EXACTLY, distinguishing ok / recovered / degraded and
 *  the recoverable (lagging-anchor) class from the fail-closed classes. */
export async function verifyAnchoredLane(root: string, ledger: GclLedger): Promise<AnchorVerification> {
  const events = await readIdentityEvents(root);
  const chain = verifyIdentityChain(events);
  if (!chain.ok) return { ok: false, status: "degraded", degraded: `identity chain integrity broken at index ${chain.brokenAt}` };
  const anchor = await readIdentityAnchor(ledger);
  const head = events[events.length - 1];
  if (!anchor) {
    if (events.length === 0) return { ok: true, status: "ok" };
    return { ok: false, status: "degraded", degraded: "identity events exist but no anchor in the revision chain", recoverable: true };
  }
  if (!head) return { ok: false, status: "degraded", degraded: `anchor at seq ${anchor.seq} but the identity log is empty (tail truncated to zero)` };
  if (head.seq < anchor.seq) return { ok: false, status: "degraded", degraded: `tail truncation: log head seq ${head.seq} < anchored seq ${anchor.seq}` };
  if (head.seq > anchor.seq) return { ok: false, status: "degraded", degraded: `unanchored tail: log head seq ${head.seq} > anchored seq ${anchor.seq} (incomplete append)`, recoverable: true };
  if (head.hash !== anchor.hash) return { ok: false, status: "degraded", degraded: `anchored head hash mismatch at seq ${anchor.seq}` };
  return { ok: true, status: anchor.recovery ? "recovered" : "ok" };
}
