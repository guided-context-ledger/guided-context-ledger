import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveLedgerDir, sha256Text } from "./ledger.js";

/**
 * Note-write attribution — the note analogue of the event/ledger action-provenance stamp. When a note
 * is written through a mediated (connector) session, the write carries WHO authored it and for WHOM,
 * on two surfaces:
 *   1. a `provenance:` block in the note's own frontmatter — the CURRENT-STATE snapshot for
 *      local/human inspection (alongside any legacy written_by/written_at);
 *   2. an append-only NOTE-WRITE RECORD per mutation — AUTHORITATIVE for mutation history, so
 *      "corrections are new records, never edits" holds even though the frontmatter snapshot is
 *      overwritten in place.
 *
 * Sparse/back-compat: every axis is optional; when none is supplied (a direct/local write with no
 * mediated session) nothing is stamped and nothing is appended, so that path stays byte-identical.
 * Legacy notes are never backfilled. Undefined fields are omitted.
 */

/** The connector-stamped identity axes for a note write, plus when they were stamped. */
export interface NoteProvenanceAxes {
  /** Executing surface that authored the write (declared, allowlist-validated). */
  actor_identity?: string | null;
  /** Accountable human the connector session acts for (e.g. kyle); session-derived. */
  principal?: string | null;
  /** The connector channel that relayed the write (server-stamped). */
  mediated_by?: string | null;
  /** Honest standing of mediated_by: a hosted connector is "declared"/"static_config", never verified.
   *  Absent on a direct/local write. Inline so the standing is audit-readable as-at-write-time. */
  mediation_standing?: string | null;
  mediation_evidence_kind?: string | null;
  /** The model/mind that authored the write (e.g. claude-opus-4-8) — declared provenance only, never a key. */
  model?: string | null;
  /** The model FAMILY / grouping (e.g. `claude`) — display/grouping only, never a key. */
  family?: string | null;
  /** The per-seat INSTANCE handle (substrate isolation) — rides for audit, never a coordination id. */
  instance?: string | null;
  /** ISO-8601 stamp time. */
  stamped_at?: string | null;
}

/** True when at least one axis is present — i.e. a mediated write worth stamping. */
export function hasProvenanceAxes(axes: NoteProvenanceAxes | null | undefined): boolean {
  if (!axes) return false;
  return [axes.actor_identity, axes.principal, axes.mediated_by, axes.model, axes.family, axes.instance, axes.stamped_at].some(
    (v) => typeof v === "string" && v.trim() !== ""
  );
}

const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Emit a value as a YAML scalar that CANNOT break out of its `key: value` position. Axis values are
 * caller-declared (model/family/surface/…) and MUST NOT be assumed scalar-safe: a newline would inject a
 * sibling frontmatter key, a `: ` would restructure the mapping, a leading indicator or a bare
 * `true`/`123` would change the parsed value. A value that is a safe plain scalar is emitted as-is (so
 * ordinary ids/timestamps stay unquoted); anything else is emitted as a JSON double-quoted scalar (YAML
 * 1.2 is a JSON superset, so JSON.stringify is a correct — and escaping — double-quoted YAML scalar).
 */
function yamlScalar(v: string): string {
  const plainSafe =
    v.length > 0 &&
    !/\p{Cc}/u.test(v) &&                             // no control chars / newlines / tabs
    !/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(v) &&              // no leading YAML indicator or whitespace
    !/[:#]$/.test(v) && !/\s$/.test(v) &&                // no trailing : / # / whitespace
    !/:\s/.test(v) &&                                     // no ": " (mapping ambiguity)
    !/\s#/.test(v) &&                                     // no " #" (comment start)
    !/^(?:true|false|null|yes|no|on|off|~)$/i.test(v) && // not a YAML bool/null keyword
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v); // not a bare number (avoid type coercion)
  return plainSafe ? v : JSON.stringify(v);
}

/** Render the nested `provenance:` block (undefined/empty axes dropped). */
function renderProvenanceBlock(axes: NoteProvenanceAxes): string {
  const rows: string[] = ["provenance:"];
  const add = (k: string, v?: string | null): void => {
    if (typeof v === "string" && v.trim() !== "") rows.push(`  ${k}: ${yamlScalar(v.trim())}`);
  };
  add("actor_identity", axes.actor_identity);
  add("principal", axes.principal);
  add("mediated_by", axes.mediated_by);
  add("mediation_standing", axes.mediation_standing);
  add("mediation_evidence_kind", axes.mediation_evidence_kind);
  add("model", axes.model);
  add("family", axes.family);
  add("instance", axes.instance);
  add("stamped_at", axes.stamped_at);
  return rows.join("\n");
}

/** Drop an existing top-level `key:` block (its line + any indented children) from a frontmatter body,
 *  so re-stamping replaces rather than duplicates the provenance snapshot. */
function stripTopLevelBlock(fmBody: string, key: string): string {
  const lines = fmBody.split("\n");
  const out: string[] = [];
  const keyRe = new RegExp(`^${key}:`);
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (/^\s+\S/.test(line)) continue; // indented child of the block → drop
      skipping = false; // a blank or top-level line ends the block
    }
    if (keyRe.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/**
 * Stamp the mediated provenance axes into a note's frontmatter as a nested `provenance:` block.
 * Creates a frontmatter fence if the note has none. Idempotent: an existing top-level `provenance:`
 * block is replaced, not duplicated. Returns the input UNCHANGED (byte-identical) when there are no
 * axes to stamp — the direct/local write path.
 */
export function stampNoteProvenance(md: string, axes: NoteProvenanceAxes): string {
  if (!hasProvenanceAxes(axes)) return md;
  const block = renderProvenanceBlock(axes);
  const m = md.match(FENCE_RE);
  if (!m) {
    // No frontmatter — prepend a fresh fence carrying just the provenance block.
    return `---\n${block}\n---\n${md}`;
  }
  const stripped = stripTopLevelBlock(m[1], "provenance");
  const newBody = stripped ? `${stripped}\n${block}` : block;
  const trailer = m[2] === "" ? "\n" : m[2];
  return `---\n${newBody}\n---${trailer}${md.slice(m[0].length)}`;
}

export type NoteWriteOperation = "write" | "append";

/** One append-only audit record per mediated note mutation. */
export interface NoteWriteRecord {
  /** Workspace-relative target path. */
  path: string;
  /** Which note primitive ran. */
  operation: NoteWriteOperation;
  /** ISO-8601 time of the mutation. */
  written_at: string;
  /** sha256 (hex) of the bytes written — the full content for a write, the appended chunk for an append. */
  content_sha256: string;
  /** Idempotency key: stable across retries of the SAME logical mutation. The exactly-once guarantee is keyed
   *  on this — an idempotent record sink dedupes on it, and readback after an ambiguous append checks it.
   *  Omitted on legacy/direct records built without one. */
  operation_id?: string;
  /** Executing surface (declared, allowlist-validated). Omitted when absent. */
  actor_identity?: string;
  /** Accountable human (session-derived). Omitted when absent. */
  principal?: string;
  /** Relaying connector channel (server-stamped). Omitted when absent. */
  mediated_by?: string;
  /** Honest standing of mediated_by, inline: a hosted connector is "declared"/"static_config", never
   *  verified. Omitted on a direct/local write. */
  mediation_standing?: string;
  mediation_evidence_kind?: string;
  /** Declared model/mind that authored the write (provenance only, never a key). Omitted when absent. */
  model?: string;
  /** Declared model FAMILY / grouping (display-only, never a key). Omitted when absent. */
  family?: string;
  /** Per-seat INSTANCE handle (substrate isolation); rides for audit, never a coordination id. Omitted when absent. */
  instance?: string;
}

const NOTE_WRITES_FILE = "note-writes.jsonl";

/** The append-only note-write log lives beside the ledger (`.gcl/`). */
export function noteWritesPath(root: string): string {
  return path.join(root, resolveLedgerDir(root), NOTE_WRITES_FILE);
}

/** sha256 (hex) of the written bytes — the record's content digest. */
export function digestContent(content: string): string {
  return sha256Text(content);
}

/** Build a note-write record, dropping any axis that is absent so the line stays sparse. */
export function buildNoteWriteRecord(
  input: {
    path: string;
    operation: NoteWriteOperation;
    content: string;
    written_at: string;
    operation_id?: string;
    axes?: NoteProvenanceAxes | null;
  }
): NoteWriteRecord {
  const rec: NoteWriteRecord = {
    path: input.path,
    operation: input.operation,
    written_at: input.written_at,
    content_sha256: digestContent(input.content),
  };
  if (typeof input.operation_id === "string" && input.operation_id.trim()) rec.operation_id = input.operation_id.trim();
  const a = input.axes;
  if (a) {
    if (typeof a.actor_identity === "string" && a.actor_identity.trim()) rec.actor_identity = a.actor_identity.trim();
    if (typeof a.principal === "string" && a.principal.trim()) rec.principal = a.principal.trim();
    if (typeof a.mediated_by === "string" && a.mediated_by.trim()) rec.mediated_by = a.mediated_by.trim();
    if (typeof a.mediation_standing === "string" && a.mediation_standing.trim()) rec.mediation_standing = a.mediation_standing.trim();
    if (typeof a.mediation_evidence_kind === "string" && a.mediation_evidence_kind.trim()) rec.mediation_evidence_kind = a.mediation_evidence_kind.trim();
    if (typeof a.model === "string" && a.model.trim()) rec.model = a.model.trim();
    if (typeof a.family === "string" && a.family.trim()) rec.family = a.family.trim();
    if (typeof a.instance === "string" && a.instance.trim()) rec.instance = a.instance.trim();
  }
  return rec;
}

/** Append a note-write record to the workspace's append-only note-write log. */
export async function appendNoteWriteRecord(root: string, record: NoteWriteRecord): Promise<void> {
  const file = noteWritesPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

/** Read the full append-only note-write log (oldest first); empty when the log does not exist. */
export async function readNoteWriteRecords(root: string): Promise<NoteWriteRecord[]> {
  try {
    const raw = await fs.readFile(noteWritesPath(root), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as NoteWriteRecord);
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// ── Atomic orchestrator: the note mutation and its authoritative record are all-or-nothing ────────────

/**
 * A note store the atomic orchestrator drives. Mutations go ONLY through atomic compare-and-set primitives —
 * there is deliberately no unconditional write/remove on this interface, so a mutation can never clobber a
 * writer the caller did not observe. Real implementations back the CAS with an O_EXCL create (for the
 * expect-absent case), a per-note lock, or a temp-file rename; the standard fixes the CAS INVARIANT, the
 * implementation picks the MECHANISM.
 */
export interface NoteStore {
  /** Current bytes of the note, or null when it does not exist. */
  read(notePath: string): Promise<string | null>;
  /**
   * Atomically write `next` IFF the note's current bytes equal `expected` (`expected === null` means
   * "expect the note absent"). Returns true iff applied. The compare and the write MUST be a single atomic
   * step against concurrent writers — a plain read-then-write does NOT satisfy this contract.
   */
  writeIfCurrent(notePath: string, expected: string | null, next: string): Promise<boolean>;
  /** Atomically remove the note IFF its current bytes equal `expected`. Returns true iff removed. */
  removeIfCurrent(notePath: string, expected: string): Promise<boolean>;
}

/** The store + record sink the orchestrator composes. Both are injected so the primitive stays
 *  strategy-neutral: the standard fixes the atomicity + exactly-once INVARIANTS, not the storage mechanism. */
export interface RecordedNoteWriteDeps {
  store: NoteStore;
  /**
   * Durably append the authoritative record IFF no record with the same `operation_id` already exists
   * (idempotent). Returns true iff THIS call added it; false iff one was already present. The check-and-append
   * MUST be atomic so a retry can never duplicate the record. A throw is treated as an AMBIGUOUS outcome and
   * resolved by `getRecord`.
   */
  appendRecordIdempotent(record: NoteWriteRecord): Promise<boolean>;
  /**
   * Canonical retrieval by `operation_id` — the durable record, or null. Returning the RECORD (not just a
   * boolean) lets the orchestrator verify a pre-existing record is for the SAME (path, operation, content):
   * a reused operation_id bound to a different write is a collision that must fail closed, never a silent
   * overwrite. (equivalent-fingerprint retrieval is acceptable in place of the whole record.)
   */
  getRecord(operation_id: string): Promise<NoteWriteRecord | null>;
}

export interface RecordedNoteWriteInput {
  notePath: string;
  operation: NoteWriteOperation;
  /** "write": the new full note body (pre-stamp). "append": the chunk appended to the existing note. */
  content: string;
  written_at: string;
  /** Stable idempotency key for THIS logical mutation — identical across retries of the same op. */
  operation_id: string;
  axes?: NoteProvenanceAxes | null;
}

/** Two records are the SAME logical write iff they target the same path with the same operation and content.
 *  `operation_id` is an idempotency key, not a free-form tag: reusing it for a different (path|operation|content)
 *  is a COLLISION that must fail closed — never a silent case where one write's mutation stands under another
 *  write's record, or a retry with a different payload returns a freshly-built non-durable record (codex R3). */
function sameLogicalWrite(a: NoteWriteRecord, b: NoteWriteRecord): boolean {
  return a.path === b.path && a.operation === b.operation && a.content_sha256 === b.content_sha256;
}
function collisionMsg(operation_id: string, existing: NoteWriteRecord, mine: NoteWriteRecord): string {
  return `operation_id "${operation_id}" is already bound to a different write ` +
    `(${existing.path}/${existing.operation}/${existing.content_sha256}); refusing to reuse it for ` +
    `${mine.path}/${mine.operation}/${mine.content_sha256} — collision, fail closed`;
}
/** Roll back THIS invocation's mutation ATOMICALLY (only if the note still holds exactly our bytes) and throw.
 *  Used whenever our mutation cannot be tied to a durable record OF OUR OWN write (append failed, or a different
 *  write holds the operation_id) — so a losing writer never returns success with an unrecorded mutation. */
async function failClosedRollback(
  store: NoteStore, notePath: string, prior: string | null, newNote: string, operation_id: string, reason: string
): Promise<never> {
  const rolledBack = prior === null ? await store.removeIfCurrent(notePath, newNote) : await store.writeIfCurrent(notePath, newNote, prior);
  if (!rolledBack) {
    throw new Error(`${reason}; AND "${notePath}" was concurrently modified after our write, so this mutation is unrecorded and could not be rolled back without clobbering newer bytes. operation_id=${operation_id}`);
  }
  throw new Error(`${reason}; note "${notePath}" atomically rolled back to its prior state (no unrecorded mutation). operation_id=${operation_id}`);
}

/**
 * Atomic note-write-with-record — the reference implementation of Note-Provenance property 9. The note
 * mutation and exactly one authoritative record are all-or-nothing AND exactly-once: this NEVER returns
 * success with an unrecorded mutation, never clobbers a writer the caller did not observe, and never leaves
 * a duplicate or orphaned record.
 *
 * Every mutation is an atomic compare-and-set: the initial write applies only if the note still holds the
 * bytes we read (`prior`), and compensation applies only if the note still holds exactly what we wrote
 * (`newNote`). A concurrent writer that lands inside either window makes the relevant CAS FAIL, so the
 * orchestrator throws and surfaces the (unrecorded) inconsistency rather than overwriting newer bytes.
 *
 * The record append is idempotent, keyed by `operation_id` — but an operation_id is bound to ONE canonical
 * (path, operation, content). On every pre-existing / already-present / ambiguous-append outcome the
 * orchestrator retrieves the durable record and verifies it is THIS write: a match is a true idempotent replay
 * (the durable record is returned, note untouched); a MISMATCH is an operation_id collision that fails closed,
 * atomically rolling back this call's mutation so the loser never leaves an unrecorded write.
 */
export async function runNoteWriteRecorded(
  deps: RecordedNoteWriteDeps,
  input: RecordedNoteWriteInput
): Promise<NoteWriteRecord> {
  const { store } = deps;
  const axes = input.axes ?? null;
  const { operation_id, notePath } = input;

  const prior = await store.read(notePath);

  let newNote: string;
  let payload: string; // the bytes content_sha256 digests
  if (input.operation === "write") {
    newNote = stampNoteProvenance(input.content, axes ?? {});
    payload = newNote; // digest the full written content
  } else {
    newNote = stampNoteProvenance((prior ?? "") + input.content, axes ?? {});
    payload = input.content; // digest the appended chunk
  }

  const record = buildNoteWriteRecord({
    path: notePath,
    operation: input.operation,
    content: payload,
    written_at: input.written_at,
    operation_id,
    axes,
  });

  // Idempotent short-circuit WITH collision detection: a pre-existing record for this operation_id must be for
  // the SAME logical write. Match ⇒ true replay, return the durable record, touch nothing. Mismatch ⇒ collision,
  // fail closed BEFORE any mutation (nothing to roll back yet).
  const pre = await deps.getRecord(operation_id);
  if (pre) {
    if (!sameLogicalWrite(pre, record)) throw new Error(collisionMsg(operation_id, pre, record) + " (before any mutation)");
    return pre;
  }

  // 1) ATOMIC initial mutation — apply newNote only if the note still holds `prior`. A concurrent writer
  //    between our read and this write makes the CAS fail; we never overwrite bytes we did not observe.
  const applied = await store.writeIfCurrent(notePath, prior, newNote);
  if (!applied) {
    const current = await store.read(notePath);
    const now = await deps.getRecord(operation_id);
    if (current === newNote && now && sameLogicalWrite(now, record)) return now; // idempotent replay already landed
    if (now && !sameLogicalWrite(now, record)) throw new Error(collisionMsg(operation_id, now, record) + " (detected at the initial write; nothing mutated)");
    throw new Error(
      `note-write "${notePath}" was concurrently modified between read and write; refusing to clobber ` +
        `(no unrecorded mutation). operation_id=${operation_id}`
    );
  }

  // 2) Append the authoritative record, idempotent by operation_id.
  let appended: boolean;
  try {
    appended = await deps.appendRecordIdempotent(record);
  } catch (appendErr) {
    // AMBIGUOUS: the append may have durably landed before throwing. Read back the CANONICAL record.
    let landed: NoteWriteRecord | null;
    try {
      landed = await deps.getRecord(operation_id);
    } catch (readErr) {
      throw new Error(
        `note-write record append outcome is UNKNOWN for "${notePath}" and readback failed; possible durable ` +
          `inconsistency. operation_id=${operation_id}. append cause: ${String(appendErr)}; readback cause: ${String(readErr)}`
      );
    }
    if (landed && sameLogicalWrite(landed, record)) return landed; // OUR write is durable → keep the note (exactly-once holds).
    // Either no record, or a DIFFERENT write holds this operation_id → our mutation must not stand unrecorded.
    return failClosedRollback(store, notePath, prior, newNote, operation_id,
      landed ? collisionMsg(operation_id, landed, record) : `note-write record append failed (cause: ${String(appendErr)})`);
  }
  if (!appended) {
    // The record was already present under this operation_id — verify it is OUR logical write, not a collision.
    const other = await deps.getRecord(operation_id);
    if (other && !sameLogicalWrite(other, record)) {
      return failClosedRollback(store, notePath, prior, newNote, operation_id, collisionMsg(operation_id, other, record));
    }
    return other ?? record; // same logical write already durable → consistent.
  }

  return record;
}
