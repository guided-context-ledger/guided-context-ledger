import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

let root: string;
let workspace: Workspace;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gcl-test-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  // fresh workspace contents each test
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  workspace = new Workspace(root);
});

test("write then read round-trips", async () => {
  await workspace.write("a.md", "# A\nhello\n");
  assert.equal(await workspace.read("a.md"), "# A\nhello\n");
});

test("write creates parent folders", async () => {
  await workspace.write("deep/nested/note.md", "x");
  assert.equal(await workspace.read("deep/nested/note.md"), "x");
});

test("append creates then appends", async () => {
  await workspace.append("log.md", "line1\n");
  await workspace.append("log.md", "line2\n");
  assert.equal(await workspace.read("log.md"), "line1\nline2\n");
});

test("list finds nested notes, sorted, .md only, no dotfiles", async () => {
  await workspace.write("b.md", "1");
  await workspace.write("sub/a.md", "2");
  await workspace.write("notes.txt", "3"); // ignored: not .md
  await fs.writeFile(path.join(root, ".hidden.md"), "4"); // ignored: dotfile
  const list = await workspace.list();
  assert.deepEqual(list, ["b.md", "sub/a.md"]);
});

test("list scoped to a subfolder", async () => {
  await workspace.write("top.md", "1");
  await workspace.write("sub/inner.md", "2");
  assert.deepEqual(await workspace.list("sub"), ["sub/inner.md"]);
});

test("list on a missing folder returns empty", async () => {
  assert.deepEqual(await workspace.list("nope"), []);
});

test("search is case-insensitive and reports path + line", async () => {
  await workspace.write("x.md", "first\nMEMORY here\nlast\n");
  const hits = await workspace.search("memory");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "x.md");
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].text, "MEMORY here");
});

test("search respects the limit", async () => {
  await workspace.write("y.md", "a\na\na\na\n");
  assert.equal((await workspace.search("a", 2)).length, 2);
});

test("search with no matches returns empty", async () => {
  await workspace.write("z.md", "nothing relevant");
  assert.deepEqual(await workspace.search("zzz"), []);
});

test("read of missing note throws", async () => {
  await assert.rejects(() => workspace.read("ghost.md"));
});

for (const bad of ["../escape.md", "../../etc/passwd", "sub/../../escape.md"]) {
  test(`path traversal blocked: ${bad}`, async () => {
    await assert.rejects(() => workspace.read(bad), /escapes the workspace/);
    await assert.rejects(() => workspace.write(bad, "x"), /escapes the workspace/);
    await assert.rejects(() => workspace.append(bad, "x"), /escapes the workspace/);
  });
}

test("workspace with a space in its path works (path-with-space regression)", async () => {
  const spaced = path.join(root, "Spaced Dir");
  await fs.mkdir(spaced, { recursive: true });
  const v = new Workspace(spaced);
  await v.write("n.md", "ok");
  assert.equal(await v.read("n.md"), "ok");
  assert.deepEqual(await v.list(), ["n.md"]);
});
