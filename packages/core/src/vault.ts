import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Raised when the vault root itself is unusable (missing or not a directory).
 * Distinct from a missing note: we never silently create the vault root — the
 * user points us at an existing folder (locked decision: no auto-created default).
 */
export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: "VAULT_MISSING" | "VAULT_NOT_DIR" | "CONFLICT",
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Vault: all read/write operations against a single markdown vault directory.
 *
 * Design rule (locked decision): the markdown files ARE the source of truth.
 * Nothing here hides data in a database. Every operation is a plain file op,
 * confined to the vault root so an agent can never read or write outside it.
 */
export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a vault-relative path and guarantee it stays inside the vault. */
  private resolveInside(relPath: string): string {
    const full = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes the vault: ${relPath}`);
    }
    return full;
  }

  /** Does the vault root exist, and is it a directory? Never throws. */
  async rootStatus(): Promise<{ exists: boolean; isDirectory: boolean }> {
    try {
      const s = await fs.stat(this.root);
      return { exists: true, isDirectory: s.isDirectory() };
    } catch {
      return { exists: false, isDirectory: false };
    }
  }

  /**
   * Guarantee the vault root is usable before a write. We create notes and
   * sub-folders inside the vault on demand, but never conjure the root itself —
   * a missing root means a misconfigured Vault folder, which must be signaled,
   * not silently created somewhere unexpected.
   */
  private async assertRootUsable(): Promise<void> {
    const { exists, isDirectory } = await this.rootStatus();
    if (!exists) {
      throw new VaultError(`Vault folder does not exist: ${this.root}`, "VAULT_MISSING");
    }
    if (!isDirectory) {
      throw new VaultError(`Vault path is not a folder: ${this.root}`, "VAULT_NOT_DIR");
    }
  }

  // Cross-process exclusive lock (same approach as the event log) — used to make
  // a compare-and-swap write atomic so two writers can't both pass the check.
  private async acquireLock(lock: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        const fd = await fs.open(lock, "wx");
        await fd.writeFile(`${process.pid}:${Date.now()}`);
        await fd.close();
        return;
      } catch (e: any) {
        // Windows can transiently surface EPERM/EACCES on concurrent exclusive
        // opens while another handle settles — treat as busy, like EEXIST.
        const lockBusy = e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES";
        if (!lockBusy) throw e;
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lock).catch(() => {});
            continue;
          }
        } catch {
          if (e.code === "EEXIST") continue; // lock vanished between checks
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new VaultError(`Could not acquire the write lock for this note (busy).`, "CONFLICT", { reason: "lock_timeout" });
        }
        await sleep(2 + Math.floor(Math.random() * 8));
      }
    }
  }
  private async releaseLock(lock: string): Promise<void> {
    await fs.unlink(lock).catch(() => {});
  }

  /** List every markdown note, optionally under a sub-folder. Returns vault-relative paths. */
  async list(subfolder = ""): Promise<string[]> {
    const start = this.resolveInside(subfolder);
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
          // Normalize to forward slashes so output is consistent cross-platform
          // and matches what Obsidian/markdown expect (Windows path.relative yields "\\").
          out.push(path.relative(this.root, abs).split(path.sep).join("/"));
        }
      }
    };
    await walk(start);
    return out.sort();
  }

  /** Read a single note's full contents. */
  async read(relPath: string): Promise<string> {
    return fs.readFile(this.resolveInside(relPath), "utf-8");
  }

  /** sha256 (hex) of a note's bytes, or "" if it does not exist. The CAS token. */
  async hashOf(relPath: string): Promise<string> {
    try {
      const buf = await fs.readFile(this.resolveInside(relPath));
      return createHash("sha256").update(buf).digest("hex");
    } catch (e: any) {
      if (e.code === "ENOENT") return "";
      throw e;
    }
  }

  /** Full-text search across all notes. Returns matches with line numbers and context. */
  async search(query: string, limit = 50): Promise<
    { path: string; line: number; text: string }[]
  > {
    const q = query.toLowerCase();
    const results: { path: string; line: number; text: string }[] = [];
    for (const rel of await this.list()) {
      const content = await this.read(rel);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ path: rel, line: i + 1, text: lines[i].trim() });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  /** Create or overwrite a note. Parent folders are created as needed. */
  async write(relPath: string, content: string, expectedHash?: string): Promise<{ hash: string }> {
    const full = this.resolveInside(relPath);
    await this.assertRootUsable();
    await fs.mkdir(path.dirname(full), { recursive: true });
    const writeNow = async (): Promise<{ hash: string }> => {
      await fs.writeFile(full, content, "utf-8");
      return { hash: createHash("sha256").update(content, "utf8").digest("hex") };
    };
    // No guard requested → unconditional overwrite (last-writer-wins).
    if (expectedHash === undefined) return writeNow();
    // Compare-and-swap: the write is rejected unless the note still matches the
    // hash the caller last read — flag-don't-clobber for documents. "" = expect-absent.
    // Locked so the check + write is atomic across processes (no lost updates).
    const lock = `${full}.lock`;
    await this.acquireLock(lock);
    try {
      const current = await this.hashOf(relPath);
      if (current !== expectedHash) {
        throw new VaultError(
          `Write conflict on ${relPath}: the note changed since you read it.`,
          "CONFLICT",
          { current_hash: current, expected_hash: expectedHash }
        );
      }
      return await writeNow();
    } finally {
      await this.releaseLock(lock);
    }
  }

  /** Append to a note (creating it if absent). */
  async append(relPath: string, content: string): Promise<void> {
    const full = this.resolveInside(relPath);
    await this.assertRootUsable();
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, content, "utf-8");
  }
}
