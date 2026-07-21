import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stampNoteProvenance,
  hasProvenanceAxes,
  buildNoteWriteRecord,
  appendNoteWriteRecord,
  readNoteWriteRecords,
  noteWritesPath,
  digestContent,
  type NoteProvenanceAxes,
} from "../src/note-provenance.js";

const AXES: NoteProvenanceAxes = {
  actor_identity: "claude-web",
  principal: "kyle",
  mediated_by: "claude-connector",
  stamped_at: "2026-06-29T03:00:00.000Z",
};

// ── Frontmatter stamping (the current-state snapshot) ──

test("no axes → byte-identical (direct/local write path is untouched)", () => {
  const md = "# Note\nbody\n";
  assert.equal(stampNoteProvenance(md, {}), md);
  assert.equal(stampNoteProvenance(md, { actor_identity: "  " }), md); // blank-only ⇒ no axes
  assert.equal(hasProvenanceAxes({}), false);
  assert.equal(hasProvenanceAxes(AXES), true);
});

test("a note WITHOUT frontmatter gets a fresh fence carrying the provenance block", () => {
  const out = stampNoteProvenance("# Title\nhello\n", AXES);
  assert.match(out, /^---\nprovenance:\n  actor_identity: claude-web\n  principal: kyle\n  mediated_by: claude-connector\n  stamped_at: 2026-06-29T03:00:00\.000Z\n---\n# Title\nhello\n$/);
});

test("a note WITH frontmatter keeps its existing keys and gains the provenance block", () => {
  const md = "---\ntitle: My Note\nwritten_by: claude-web\nwritten_at: 2026-06-29T02:00:00.000Z\n---\n# Body\n";
  const out = stampNoteProvenance(md, AXES);
  assert.match(out, /title: My Note/);
  assert.match(out, /written_by: claude-web/);
  assert.match(out, /written_at: 2026-06-29T02:00:00\.000Z/);
  assert.match(out, /provenance:\n  actor_identity: claude-web\n  principal: kyle\n  mediated_by: claude-connector\n  stamped_at: 2026-06-29T03:00:00\.000Z/);
  assert.match(out, /\n---\n# Body\n$/);
});

test("re-stamping REPLACES the provenance block, never duplicates it", () => {
  const once = stampNoteProvenance("# B\n", AXES);
  const twice = stampNoteProvenance(once, { ...AXES, principal: "kyle", actor_identity: "codex" });
  assert.equal((twice.match(/provenance:/g) || []).length, 1);
  assert.match(twice, /actor_identity: codex/);
  assert.doesNotMatch(twice, /actor_identity: claude-web/);
  // body survives the re-stamp
  assert.match(twice, /\n---\n# B\n$/);
});

test("undefined axes are omitted from the block", () => {
  const out = stampNoteProvenance("# C\n", { principal: "kyle", mediated_by: "claude-connector" });
  assert.match(out, /principal: kyle/);
  assert.match(out, /mediated_by: claude-connector/);
  assert.doesNotMatch(out, /actor_identity:/);
  assert.doesNotMatch(out, /stamped_at:/);
});

// ── Append-only note-write record (authoritative mutation history) ──

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "noteprov-test-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
});

test("record carries axes + path + operation + content digest; sparse axes dropped", () => {
  const rec = buildNoteWriteRecord({ path: "a/b.md", operation: "write", content: "hello", written_at: AXES.stamped_at!, axes: AXES });
  assert.equal(rec.path, "a/b.md");
  assert.equal(rec.operation, "write");
  assert.equal(rec.written_at, AXES.stamped_at);
  assert.equal(rec.content_sha256, digestContent("hello"));
  assert.equal(rec.actor_identity, "claude-web");
  assert.equal(rec.principal, "kyle");
  assert.equal(rec.mediated_by, "claude-connector");

  const local = buildNoteWriteRecord({ path: "x.md", operation: "append", content: "y", written_at: "2026-06-29T03:01:00.000Z", axes: null });
  assert.equal(local.actor_identity, undefined);
  assert.equal(local.principal, undefined);
  assert.equal(local.mediated_by, undefined);
  assert.equal(local.content_sha256, digestContent("y"));
});

test("append-only: records round-trip oldest-first and accumulate", async () => {
  assert.deepEqual(await readNoteWriteRecords(root), []); // no log yet
  await appendNoteWriteRecord(root, buildNoteWriteRecord({ path: "n.md", operation: "write", content: "v1", written_at: "2026-06-29T03:00:00.000Z", axes: AXES }));
  await appendNoteWriteRecord(root, buildNoteWriteRecord({ path: "n.md", operation: "append", content: "v2", written_at: "2026-06-29T03:05:00.000Z", axes: AXES }));
  const recs = await readNoteWriteRecords(root);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].operation, "write");
  assert.equal(recs[1].operation, "append");
  assert.equal(recs[0].content_sha256, digestContent("v1"));
  assert.equal(recs[1].content_sha256, digestContent("v2"));
});

test("the note-write log lives under the ledger dir (.gcl by default)", async () => {
  assert.equal(noteWritesPath(root), path.join(root, ".gcl", "note-writes.jsonl"));
  await appendNoteWriteRecord(root, buildNoteWriteRecord({ path: "n.md", operation: "write", content: "z", written_at: "2026-06-29T03:00:00.000Z", axes: AXES }));
  // a corrupt/garbage line is not produced; the file is valid JSONL
  const raw = await fs.readFile(noteWritesPath(root), "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.doesNotThrow(() => JSON.parse(raw.trim()));
});
