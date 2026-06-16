import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LedgerError extends Error {
  constructor(message: string, readonly code: "CONFLICT" | "BAD_PATH" | "IO", readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface RevisionArtifact {
  path: string;
  lane: string;
  hash: string;
}

/** Ledger schema version at which a revision first carries a stamped action-provenance envelope and
 *  the recipe folds it into the revision_id hash. Revisions below this use the legacy recipe and have
 *  no provenance block — see revisionId(). Kept in sync with readback's PROVENANCE_STAMPED_FROM. */
export const STAMPED_FROM = "0.2.0";

export type PrincipalSource = "self_report" | "connector_session" | "org_verified";

/** Action-provenance envelope (schema 0.2.0+). Stamped DECLARATIONS of who acted, for whom, under
 *  what authority, and where the content came from. Every field here is IN the revision_id hash
 *  (tamper-evident): mutating any of them changes the id. Three identity roles are kept distinct —
 *  `principal_*` (accountable human), `actor_identity` (executing agent), `authority_*` (per-action
 *  authorizer) — all the same person at n=1, separable at org scale. Engine-DERIVED assessments
 *  (lane_crossing, authority_status, evidence_fidelity, ...) are NOT here: they are recomputable
 *  projections and are never hashed. */
export interface ActionProvenance {
  /** Accountable human who drove the work (architect / credit / accountability). */
  principal_id: string;
  /** Trust tier of how principal_id was established. */
  principal_source: PrincipalSource;
  /** Executing agent identity (distinct from the principal human). */
  actor_identity?: string | null;
  originated_by?: string | null;
  /** Ordered relay chain. SEMANTIC order — preserved as-authored, NOT sorted (unlike artifacts/lanes). */
  relayed_through?: string[];
  posted_by?: string | null;
  origin_ref?: string | null;
  origin_excerpt?: string | null;
  evidence_kind?: string | null;
  /** Per-action authorizer (distinct from principal and actor). */
  authority_source?: string | null;
  authority_scope?: string | null;
  declared_lane?: string | null;
  acted_lane?: string | null;
}

export interface RevisionEnvelope {
  parent_revision: string;
  commit_id: string;
  actor: string;
  session: string;
  timestamp: string;
  artifacts: RevisionArtifact[];
  lanes: string[];
  spaces_contract_version: string | null;
  schema_version: string | null;
  /** Stamped action provenance (schema >= STAMPED_FROM). Absent on legacy 0.1.x revisions. */
  provenance?: ActionProvenance | null;
}

/** Dotted numeric version compare ("0.1.1" >= "0.2.0"). A missing/non-numeric version sorts below
 *  everything (legacy). Mirrors readback.versionGte — duplicated deliberately so the hash recipe has
 *  no cross-module dependency that could drift its determinism. */
export function versionGte(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** Canonicalize a principal id to ONE deterministic form before it enters the hash, so two clients
 *  cannot fork the revision_id for the same human over a trivial formatting difference (Codex
 *  determinism caveat, seq 125/126). Trim, lowercase, collapse internal whitespace. This is a
 *  byte-level normalization only; mapping distinct identifiers for the same person (e.g. a display
 *  name vs an email) to one canonical id is the connector's job (it stamps principal_source=
 *  connector_session from one session identity), not the engine's. */
export function canonicalizePrincipal(id: string): string {
  return id.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface RevisionRecord extends RevisionEnvelope {
  revision_id: string;
}

export class GclLedger {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolveInside(relPath: string): string {
    const full = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new LedgerError(`Path escapes the vault: ${relPath}`, "BAD_PATH");
    }
    return full;
  }

  private async acquireLock(lock: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        const fd = await fs.open(lock, "wx");
        await fd.writeFile(`${process.pid}:${Date.now()}`);
        await fd.close();
        return;
      } catch (e: any) {
        const lockBusy = e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES";
        if (!lockBusy) throw e;
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lock).catch(() => {});
            continue;
          }
        } catch {
          if (e.code === "EEXIST") continue;
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new LedgerError("Could not acquire ledger lock.", "CONFLICT", { reason: "lock_timeout" });
        }
        await sleep(2 + Math.floor(Math.random() * 8));
      }
    }
  }

  private async releaseLock(lock: string): Promise<void> {
    await fs.unlink(lock).catch(() => {});
  }

  private headPath(): string {
    return this.resolveInside(".gcl/HEAD");
  }

  private ledgerPath(): string {
    return this.resolveInside(".gcl/ledger/revisions.jsonl");
  }

  async getHead(): Promise<string> {
    try {
      const content = await fs.readFile(this.headPath(), "utf8");
      return content.trim() || "rev_genesis";
    } catch (e: any) {
      if (e.code === "ENOENT") return "rev_genesis";
      throw e;
    }
  }

  stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => this.stableStringify(v)).join(",")}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${this.stableStringify(obj[k])}`)
      .join(",")}}`;
  }

  /** Content-addressed revision id, VERSIONED on schema_version so the recipe can evolve without
   *  rewriting history:
   *   - legacy (< STAMPED_FROM): the original recipe over the 9 base fields. Provenance is excluded
   *     entirely, so every pre-0.2.0 id is byte-for-byte unchanged (the migration-safety regression
   *     gates exactly this).
   *   - stamped (>= STAMPED_FROM): the same base PLUS the canonical action-provenance envelope.
   *  artifacts/lanes are sorted in both paths; relayed_through is NEVER sorted (semantic order);
   *  principal_id is canonicalized before hashing (Codex determinism caveat). */
  revisionId(envelope: RevisionEnvelope): string {
    const base: Record<string, unknown> = {
      parent_revision: envelope.parent_revision,
      commit_id: envelope.commit_id,
      actor: envelope.actor,
      session: envelope.session,
      timestamp: envelope.timestamp,
      artifacts: [...envelope.artifacts].sort((a, b) => `${a.lane}:${a.path}`.localeCompare(`${b.lane}:${b.path}`)),
      lanes: [...envelope.lanes].sort(),
      spaces_contract_version: envelope.spaces_contract_version,
      schema_version: envelope.schema_version,
    };
    if (versionGte(envelope.schema_version, STAMPED_FROM)) {
      base.provenance = envelope.provenance ? this.canonicalProvenance(envelope.provenance) : null;
    }
    return `rev_${createHash("sha256").update(this.stableStringify(base), "utf8").digest("hex").slice(0, 24)}`;
  }

  /** Canonical provenance for hashing: principal_id normalized to one deterministic form;
   *  undefined-valued keys dropped (so present-as-undefined and absent hash identically — an explicit
   *  null stays distinct as "explicitly none"); relayed_through left as an ordered list. */
  private canonicalProvenance(p: ActionProvenance): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined) out[k] = v;
    }
    out.principal_id = canonicalizePrincipal(p.principal_id);
    return out;
  }

  /** Raw append-only ledger contents, in file order. Includes entries that a crash between the
   *  ledger append and the HEAD write may have left unreachable from HEAD — callers that need
   *  authoritative state must use readReachableRevisions(), not this (Inv 16). */
  async readRevisions(): Promise<RevisionRecord[]> {
    try {
      const content = await fs.readFile(this.ledgerPath(), "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RevisionRecord);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  /** The canonical revision chain: reconstructed by walking parent links backward from HEAD,
   *  returned oldest→newest (genesis→HEAD). Entries not on this chain are pending/unreachable
   *  (e.g. a crash that appended the ledger but never advanced HEAD) and are NOT valid state
   *  until recovery resolves them (Inv 16). Never throws on a broken chain — a HEAD pointing at a
   *  missing revision degrades to an empty authoritative set rather than crashing (Inv 17). */
  async readReachableRevisions(): Promise<RevisionRecord[]> {
    const head = await this.getHead();
    if (head === "rev_genesis") return [];
    const byId = new Map((await this.readRevisions()).map((r) => [r.revision_id, r]));
    const chain: RevisionRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = head;
    while (cursor && cursor !== "rev_genesis") {
      if (seen.has(cursor)) break; // cycle guard — malformed parent links
      seen.add(cursor);
      const record = byId.get(cursor);
      if (!record) break; // HEAD (or an ancestor) references a revision absent from the ledger
      chain.push(record);
      cursor = record.parent_revision;
    }
    return chain.reverse();
  }

  /** Ledger entries not reachable from HEAD — recovery candidates, not authoritative state.
   *  These are what a crash between the ledger append and the HEAD advance leaves behind. The
   *  reserved genesis record is excluded: it is the chain ROOT (every walk terminates at it), not an
   *  unreachable orphan — counting it as a recovery candidate is both a miscount and, once such
   *  candidates are summarized inline, a crash (genesis has no artifacts/lanes arrays). */
  async readUnreachableRevisions(): Promise<RevisionRecord[]> {
    const reachable = new Set((await this.readReachableRevisions()).map((r) => r.revision_id));
    return (await this.readRevisions()).filter(
      (r) => !reachable.has(r.revision_id) && r.revision_id !== "rev_genesis" && !(r as { genesis?: boolean }).genesis,
    );
  }

  async finalizeRevision(expectedRevision: string, envelope: RevisionEnvelope): Promise<RevisionRecord> {
    const head = this.headPath();
    const lock = `${head}.lock`;
    await fs.mkdir(path.dirname(head), { recursive: true });
    await this.acquireLock(lock);
    try {
      const current = await this.getHead();
      if (current !== expectedRevision) {
        throw new LedgerError("HEAD changed before commit could advance.", "CONFLICT", {
          expected_revision: expectedRevision,
          actual_revision: current,
        });
      }
      const record: RevisionRecord = { ...envelope, revision_id: this.revisionId(envelope) };
      const ledger = this.ledgerPath();
      await fs.mkdir(path.dirname(ledger), { recursive: true });
      await fs.appendFile(ledger, JSON.stringify(record) + "\n", "utf8");
      await fs.writeFile(head, `${record.revision_id}\n`, "utf8");
      return record;
    } finally {
      await this.releaseLock(lock);
    }
  }
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
