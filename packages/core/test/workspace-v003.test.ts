import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, WorkspaceError } from "../src/workspace.js";

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-v003-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("rootStatus reports an existing directory", async () => {
  const v = new Workspace(root);
  assert.deepEqual(await v.rootStatus(), { exists: true, isDirectory: true });
});

test("rootStatus reports a missing root", async () => {
  const v = new Workspace(path.join(root, "does-not-exist"));
  assert.deepEqual(await v.rootStatus(), { exists: false, isDirectory: false });
});

test("write to a missing workspace root throws WorkspaceError and does NOT create it", async () => {
  const missing = path.join(root, "ghost-workspace");
  const v = new Workspace(missing);
  await assert.rejects(
    () => v.write("note.md", "x"),
    (e) => e instanceof WorkspaceError && (e as WorkspaceError).code === "WORKSPACE_MISSING"
  );
  // no silent create: the root must still not exist
  assert.deepEqual(await v.rootStatus(), { exists: false, isDirectory: false });
});

test("append to a missing workspace root throws WorkspaceError", async () => {
  const v = new Workspace(path.join(root, "ghost2"));
  await assert.rejects(
    () => v.append("log.md", "x"),
    (e) => e instanceof WorkspaceError && (e as WorkspaceError).code === "WORKSPACE_MISSING"
  );
});

test("a file (not a folder) as workspace root is rejected on write", async () => {
  const filePath = path.join(root, "afile");
  await fs.writeFile(filePath, "x");
  const v = new Workspace(filePath);
  const s = await v.rootStatus();
  assert.equal(s.exists, true);
  assert.equal(s.isDirectory, false);
  await assert.rejects(
    () => v.write("n.md", "y"),
    (e) => e instanceof WorkspaceError && (e as WorkspaceError).code === "WORKSPACE_NOT_DIR"
  );
});

test("writes still work normally inside an existing workspace (regression)", async () => {
  const v = new Workspace(root);
  await v.write("deep/nested/ok.md", "hi");
  assert.equal(await v.read("deep/nested/ok.md"), "hi");
});
