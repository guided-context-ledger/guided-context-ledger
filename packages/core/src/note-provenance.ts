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
    axes?: NoteProvenanceAxes | null;
  }
): NoteWriteRecord {
  const rec: NoteWriteRecord = {
    path: input.path,
    operation: input.operation,
    written_at: input.written_at,
    content_sha256: digestContent(input.content),
  };
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
