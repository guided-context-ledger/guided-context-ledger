import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, WorkspaceError } from "../src/workspace.js";

let root: string;
let workspace: Workspace;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-cas-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  workspace = new Workspace(root);
});

test("hashOf is empty for a missing note, hex for an existing one", async () => {
  assert.equal(await workspace.hashOf("nope.md"), "");
  const { hash } = await workspace.write("a.md", "hello");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await workspace.hashOf("a.md"), hash);
});

test('expected_hash="" creates only when absent', async () => {
  const { hash } = await workspace.write("new.md", "v1", "");
  assert.equal(await workspace.read("new.md"), "v1");
  // second create-only must conflict (it now exists)
  await assert.rejects(
    () => workspace.write("new.md", "v2", ""),
    (e) => e instanceof WorkspaceError && (e as WorkspaceError).code === "CONFLICT"
  );
  assert.equal(await workspace.read("new.md"), "v1"); // unchanged
  assert.ok(hash);
});

test("CAS with the correct hash succeeds; wrong hash conflicts and does not write", async () => {
  await workspace.write("doc.md", "original");
  const h = await workspace.hashOf("doc.md");
  const r = await workspace.write("doc.md", "edited", h);
  assert.equal(await workspace.read("doc.md"), "edited");
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  // a stale write (using the old hash) must be rejected
  await assert.rejects(
    () => workspace.write("doc.md", "stale clobber", h),
    (e) => {
      const ve = e as WorkspaceError;
      return ve instanceof WorkspaceError && ve.code === "CONFLICT" && (ve.detail?.current_hash as string) === r.hash;
    }
  );
  assert.equal(await workspace.read("doc.md"), "edited"); // not clobbered
});

test("write without expected_hash overwrites unconditionally (last-writer-wins)", async () => {
  await workspace.write("x.md", "one");
  await workspace.write("x.md", "two");
  assert.equal(await workspace.read("x.md"), "two");
});

test("concurrent CAS with the same base hash: exactly one wins, no lost update", async () => {
  await workspace.write("race.md", "base");
  const base = await workspace.hashOf("race.md");
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => workspace.write("race.md", `writer-${i}`, base))
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter(
    (r) => r.status === "rejected" && (r.reason as WorkspaceError).code === "CONFLICT"
  );
  assert.equal(ok.length, 1, "exactly one writer should win");
  assert.equal(conflicts.length, 5, "the rest must be rejected as conflicts, not silently lost");
  // final content is the winner's, and its hash matches what the winner returned
  const finalHash = await workspace.hashOf("race.md");
  const winnerHash = (ok[0] as PromiseFulfilledResult<{ hash: string }>).value.hash;
  assert.equal(finalHash, winnerHash);
});
