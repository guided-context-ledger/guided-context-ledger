import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";

let root: string;
let vault: Vault;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-test-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  // fresh vault contents each test
  for (const e of await fs.readdir(root)) await fs.rm(path.join(root, e), { recursive: true, force: true });
  vault = new Vault(root);
});

test("write then read round-trips", async () => {
  await vault.write("a.md", "# A\nhello\n");
  assert.equal(await vault.read("a.md"), "# A\nhello\n");
});

test("write creates parent folders", async () => {
  await vault.write("deep/nested/note.md", "x");
  assert.equal(await vault.read("deep/nested/note.md"), "x");
});

test("append creates then appends", async () => {
  await vault.append("log.md", "line1\n");
  await vault.append("log.md", "line2\n");
  assert.equal(await vault.read("log.md"), "line1\nline2\n");
});

test("list finds nested notes, sorted, .md only, no dotfiles", async () => {
  await vault.write("b.md", "1");
  await vault.write("sub/a.md", "2");
  await vault.write("notes.txt", "3"); // ignored: not .md
  await fs.writeFile(path.join(root, ".hidden.md"), "4"); // ignored: dotfile
  const list = await vault.list();
  assert.deepEqual(list, ["b.md", "sub/a.md"]);
});

test("list scoped to a subfolder", async () => {
  await vault.write("top.md", "1");
  await vault.write("sub/inner.md", "2");
  assert.deepEqual(await vault.list("sub"), ["sub/inner.md"]);
});

test("list on a missing folder returns empty", async () => {
  assert.deepEqual(await vault.list("nope"), []);
});

test("search is case-insensitive and reports path + line", async () => {
  await vault.write("x.md", "first\nMEMORY here\nlast\n");
  const hits = await vault.search("memory");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "x.md");
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].text, "MEMORY here");
});

test("search respects the limit", async () => {
  await vault.write("y.md", "a\na\na\na\n");
  assert.equal((await vault.search("a", 2)).length, 2);
});

test("search with no matches returns empty", async () => {
  await vault.write("z.md", "nothing relevant");
  assert.deepEqual(await vault.search("zzz"), []);
});

test("read of missing note throws", async () => {
  await assert.rejects(() => vault.read("ghost.md"));
});

for (const bad of ["../escape.md", "../../etc/passwd", "sub/../../escape.md"]) {
  test(`path traversal blocked: ${bad}`, async () => {
    await assert.rejects(() => vault.read(bad), /escapes the vault/);
    await assert.rejects(() => vault.write(bad, "x"), /escapes the vault/);
    await assert.rejects(() => vault.append(bad, "x"), /escapes the vault/);
  });
}

test("vault with a space in its path works (Agent Hub regression)", async () => {
  const spaced = path.join(root, "Spaced Dir");
  await fs.mkdir(spaced, { recursive: true });
  const v = new Vault(spaced);
  await v.write("n.md", "ok");
  assert.equal(await v.read("n.md"), "ok");
  assert.deepEqual(await v.list(), ["n.md"]);
});
