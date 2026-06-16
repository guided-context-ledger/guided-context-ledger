#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Vault,
  VaultError,
  EventLog,
  EventError,
  GclLedger,
  LedgerError,
  sha256Text,
  STAMPED_FROM,
  type RevisionArtifact,
  type ActionProvenance,
} from "@guided-context-ledger/core";

/**
 * Guided Context Ledger — local reference connector.
 *
 * A minimal, transport-agnostic MCP server that runs the GCL guided loop over a
 * plain-files workspace: orient → events/handoffs → claims/leases → nudge →
 * commit a durable revision → readback. Detection, not enforcement: it RECORDS
 * declarations (provenance is self-reported and hash-anchored), it does not grant
 * or enforce authority. The enforcement engine (onboarding contract, protected
 * namespaces, authority/lane blocking) and hosted multi-agent orchestration are
 * fast-follow, not part of this open reference connector.
 *
 * Transport: stdio (local-first). Set GCL_WORKSPACE to the workspace root; if
 * unset, the current working directory is used.
 */
const VERSION = "0.1.0";

const envPath = process.env.GCL_WORKSPACE?.trim();
const hasRealPath = !!envPath && envPath.length > 0 && !envPath.includes("${");
const WORKSPACE_PATH = hasRealPath ? (envPath as string) : process.cwd();
const vault = new Vault(WORKSPACE_PATH);
const events = new EventLog(WORKSPACE_PATH);
const ledger = new GclLedger(WORKSPACE_PATH);

/** Connector principal — the accountable HUMAN this session acts for, read from the trusted session
 *  boundary (env), never from a tool-call parameter. Absent ⇒ commits fall back honestly to
 *  self_report (principal_id = actor) rather than feigning a verified session. */
const sessionPrincipalId = process.env.GCL_PRINCIPAL_ID?.trim();
const hasSessionPrincipal =
  !!sessionPrincipalId && sessionPrincipalId.length > 0 && !sessionPrincipalId.includes("${");

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const okStruct = (text: string, structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const failStruct = (text: string, structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
  isError: true,
});

/** Minimal YAML frontmatter parser → flat string map (top-level `key: value` only). */
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

/** Pull the first fenced yaml block that declares `rules:` from a doc. */
function extractYamlRules(md: string): string | null {
  const re = /```ya?ml\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (/(^|\n)\s*rules:/.test(m[1])) return m[1].trim();
  }
  return null;
}

/** Wrap a tool body so any error returns a clean MCP tool error instead of crashing the call. */
async function safe(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VaultError) {
      return fail(
        `${err.message}\nFix: set GCL_WORKSPACE to an existing directory, then fully restart the client.`
      );
    }
    if (err instanceof EventError) return fail(`Error: ${err.message}`);
    if (err instanceof LedgerError) return fail(`Error: ${err.message}`);
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = msg.includes("ENOENT") ? "Note or folder not found." : msg;
    return fail(`Error: ${friendly}`);
  }
}

/** If the workspace root is unusable, return a clear misconfiguration message; otherwise null. */
async function workspaceProblem(): Promise<string | null> {
  const { exists, isDirectory } = await vault.rootStatus();
  if (!exists)
    return `Workspace folder does not exist: ${vault.root}\nFix: set GCL_WORKSPACE to an existing directory, then fully restart the client.`;
  if (!isDirectory) return `Workspace path is not a folder: ${vault.root}`;
  return null;
}

const INSTRUCTIONS =
  "Guided Context Ledger connector. First call orient(actor=<your per-interface id>) every session — " +
  "your actor id is per-interface (e.g. 'claude-cli', 'codex'), not a model or family name. " +
  "Run the loop: orient → post events/handoffs → claim work (with a lease) → nudge → commit a durable " +
  "revision → readback. Provenance is declared and recorded, not enforced.";

const server = new McpServer({ name: "guided-context-ledger", version: VERSION }, { instructions: INSTRUCTIONS });

server.tool(
  "orient",
  "Arrival briefing in one deterministic call. Returns your brain/capabilities status, active constraints, available spaces, per-thread unread counts since you last posted, which threads need you, what's addressed to you, presence, and the current ledger HEAD. Call this FIRST each session, passing your per-interface actor id.",
  { actor: z.string().min(1).describe("Your per-interface coordination id, e.g. 'claude-cli' or 'codex' (not a model/family name).") },
  ({ actor }) =>
    safe(async () => {
      const problem = await workspaceProblem();
      if (problem) return fail(problem);

      // A2 / per-interface identity: the brain is resolved at users/<actor>/brain.md where <actor> is
      // the per-interface coordination id. If absent, the diagnostic names the convention explicitly so
      // a new user does not silently file their brain under a model/family name and find it invisible.
      const brainPath = `users/${actor}/brain.md`;
      let brain: Record<string, unknown>;
      try {
        const fm = parseFrontmatter(await vault.read(brainPath));
        brain = { path: brainPath, present: true, status: fm.status ?? null, summary: fm.summary ?? null };
      } catch {
        brain = { path: brainPath, present: false, status: null, summary: null };
      }

      let capabilitiesPresent = false;
      try {
        await vault.read(`users/${actor}/capabilities.md`);
        capabilitiesPresent = true;
      } catch {
        /* optional */
      }

      let constraints: Record<string, unknown> = { present: false, rules: null };
      for (const p of ["spaces/constraints.md", "spaces/compliance.md"]) {
        try {
          const c = await vault.read(p);
          constraints = { present: true, path: p, rules: extractYamlRules(c) };
          break;
        } catch {
          /* try next */
        }
      }

      const spaces = await vault.list("spaces");
      const ov = await events.overview(actor);
      const needsMe = ov.threads.filter((t) => t.needs_me).map((t) => t.thread);
      const openForMe = ov.open_for_me;
      const head = await ledger.getHead();

      const brainState = brain.present
        ? (brain.status as string | null) ?? "present"
        : `ABSENT — author ${brainPath} (use your per-interface actor id, not a model/family name)`;
      const text =
        `Oriented ${actor} · guided-context-ledger v${VERSION}. brain: ${brainState}; ` +
        `threads needing you: ${needsMe.length}${needsMe.length ? ` (${needsMe.join(", ")})` : ""}; ` +
        `open for you: ${openForMe.length}${openForMe.length ? ` (${openForMe.map((o) => o.event_id).join(", ")})` : ""}; ` +
        `constraints: ${constraints.present ? "declared (recorded, not enforced)" : "none"}; ledger HEAD: ${head}.`;

      return okStruct(text, {
        actor,
        server: "guided-context-ledger",
        server_version: VERSION,
        workspace: { path: vault.root },
        brain,
        capabilities_present: capabilitiesPresent,
        constraints,
        spaces,
        threads: ov.threads,
        needs_me: needsMe,
        open_for_me: openForMe,
        presence: ov.presence,
        ledger_head: head,
      });
    })
);

server.tool(
  "workspace_info",
  "Report the resolved workspace: absolute path, whether it exists, and how many notes it holds. Use this to confirm every agent is pointed at the same shared workspace (handoff debugging).",
  {},
  () =>
    safe(async () => {
      const { exists, isDirectory } = await vault.rootStatus();
      const lines = [
        `Server: guided-context-ledger v${VERSION}`,
        `Workspace path: ${vault.root}`,
        `Exists: ${exists ? "yes" : "no"}`,
        `Is directory: ${isDirectory ? "yes" : "no"}`,
      ];
      const noteCount = exists && isDirectory ? (await vault.list()).length : null;
      if (noteCount !== null) lines.push(`Notes: ${noteCount}`);
      else lines.push("⚠ Misconfigured — set GCL_WORKSPACE to an existing folder and fully restart the client.");
      return okStruct(lines.join("\n"), {
        server: "guided-context-ledger",
        version: VERSION,
        path: vault.root,
        exists,
        is_directory: isDirectory,
        notes: noteCount,
      });
    })
);

server.tool(
  "list_notes",
  "List every markdown note in the workspace, optionally under a sub-folder. Returns workspace-relative paths.",
  { subfolder: z.string().optional().describe("Optional sub-folder to scope the listing.") },
  ({ subfolder }) =>
    safe(async () => {
      const problem = await workspaceProblem();
      if (problem) return fail(problem);
      const notes = await vault.list(subfolder ?? "");
      return okStruct(notes.length ? notes.join("\n") : "(workspace is reachable but contains no notes yet)", { notes });
    })
);

server.tool(
  "read_note",
  "Read the full contents of a single note by its workspace-relative path.",
  { path: z.string().min(1).describe("Workspace-relative path, e.g. 'users/claude-cli/brain.md'.") },
  ({ path: p }) =>
    safe(async () => {
      try {
        const text = await vault.read(p);
        const hash = await vault.hashOf(p);
        return okStruct(text, { path: p, hash, content: text });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return fail(`No note found at "${p}". Use list_notes to see what exists.`);
        if (code === "EISDIR")
          return fail(`"${p}" is a folder, not a note. Use list_notes with subfolder="${p}" to see the notes inside it.`);
        throw err;
      }
    })
);

server.tool(
  "search_notes",
  "Full-text search across every note. Returns matching lines with their path and line number.",
  {
    query: z.string().min(1).describe("Text to search for (case-insensitive)."),
    limit: z.number().int().positive().optional().describe("Max matches to return (default 50)."),
  },
  ({ query, limit }) =>
    safe(async () => {
      if (!query.trim()) return fail("Provide a non-empty search query.");
      const problem = await workspaceProblem();
      if (problem) return fail(problem);
      const hits = await vault.search(query, limit ?? 50);
      const text = hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") : `(no matches for "${query}")`;
      return okStruct(text, { matches: hits });
    })
);

server.tool(
  "write_note",
  'Create or overwrite a note. Parent folders are created automatically. For safe concurrent edits, pass expected_hash (from read_note) — the write is rejected if the note changed since you read it (compare-and-swap). Use expected_hash="" to mean "only create if it does not exist yet". Omit it to overwrite unconditionally.',
  {
    path: z.string().min(1).describe("Workspace-relative path to write."),
    content: z.string().describe("Full markdown content for the note."),
    expected_hash: z
      .string()
      .optional()
      .describe('CAS guard: the note\'s prior hash from read_note. "" means expect-absent. Omit to overwrite unconditionally.'),
  },
  ({ path: p, content, expected_hash }) =>
    safe(async () => {
      try {
        const { hash } = await vault.write(p, content, expected_hash);
        return okStruct(`Wrote ${p}`, { path: p, hash });
      } catch (err) {
        if (err instanceof VaultError && err.code === "CONFLICT") {
          const cur = (err.detail?.current_hash as string) ?? "";
          return failStruct(`${err.message} Re-read it, merge, and retry with expected_hash="${cur}".`, {
            conflict: true,
            path: p,
            current_hash: cur,
            expected_hash: expected_hash ?? null,
          });
        }
        throw err;
      }
    })
);

server.tool(
  "append_note",
  "Append content to a note, creating it if it does not exist.",
  {
    path: z.string().min(1).describe("Workspace-relative path to append to."),
    content: z.string().describe("Markdown to append."),
  },
  ({ path: p, content }) =>
    safe(async () => {
      await vault.append(p, content);
      return ok(`Appended to ${p}`);
    })
);

// ── Coordination layer: the agent-to-agent event trail (cross-process safe) ──

server.tool(
  "append_event",
  "Append an event to a coordination thread. Cross-process safe: the server locks, stamps the time, and assigns a monotonic seq. type: message (default), ack, handoff, conflict, or claim (take ownership of an open work item so peers don't double-take it).",
  {
    thread: z.string().min(1).describe("Thread id (letters, digits, . _ - )."),
    actor: z.string().min(1).describe("Who is writing — your per-interface coordination id."),
    body: z.string().describe("Event content."),
    type: z.enum(["message", "ack", "handoff", "conflict", "claim"]).optional().describe("Event type. Default: message."),
    parent_event_id: z
      .string()
      .optional()
      .describe("Optional id of the event this replies to (causal link). REQUIRED for a claim — points at the work item being claimed."),
    addressed_to: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional coordination actor ids this event is directed at. Surfaces in their orient as open_for_me until they respond."),
    requires_response: z
      .boolean()
      .optional()
      .describe("Whether an addressee owes a response. Defaults by type (handoff/conflict=true, else false)."),
    claim_status: z
      .enum(["claimed", "released", "completed"])
      .optional()
      .describe("For type=claim only: 'claimed' takes/renews ownership of parent_event_id; 'released' frees it; 'completed' closes it. First unexpired claim wins."),
    lease_expires_at: z
      .string()
      .optional()
      .describe("For claim_status='claimed': ISO-8601 lease end. Omit for the 30-min default; renew by appending another 'claimed' before expiry."),
  },
  ({ thread, actor, body, type, parent_event_id, addressed_to, requires_response, claim_status, lease_expires_at }) =>
    safe(async () => {
      const r = await events.append(thread, actor, body, type ?? "message", parent_event_id ?? null, {
        addressedTo: addressed_to,
        requiresResponse: requires_response,
        claimStatus: claim_status,
        ...(lease_expires_at !== undefined ? { leaseExpiresAt: lease_expires_at } : {}),
      });
      return okStruct(`Appended event ${r.event_id} (seq ${r.seq}) at ${r.created_at}`, { ...r });
    })
);

server.tool(
  "read_events",
  "Read new events from a coordination thread. Returns only events with seq greater than after_seq (cursor → just the delta). If wait_ms > 0 and there are no new events, the call blocks until new events arrive or the wait elapses (long-poll). Pass your actor to record presence.",
  {
    thread: z.string().min(1).describe("Thread id."),
    after_seq: z.number().int().nonnegative().optional().describe("Return events after this seq (your cursor). Default 0."),
    wait_ms: z.number().int().nonnegative().optional().describe("Long-poll: block up to this many ms for new events. Default 0."),
    actor: z.string().optional().describe("Your coordination id; recorded as presence/last-active."),
  },
  ({ thread, after_seq, wait_ms, actor }) =>
    safe(async () => {
      const r = await events.read(thread, after_seq ?? 0, wait_ms ?? 0, actor);
      return okStruct(JSON.stringify(r), r as unknown as Record<string, unknown>);
    })
);

server.tool(
  "list_threads",
  "List coordination threads that have an event log, so you can discover threads without knowing their ids in advance.",
  {},
  () =>
    safe(async () => {
      const threads = await events.listThreads();
      return okStruct(threads.length ? threads.join("\n") : "(no threads yet)", { threads });
    })
);

// ── Ledger layer: slim, ungated commit + readback (detection, not enforcement) ──

server.tool(
  "gcl_head",
  "Read the canonical ledger HEAD from .gcl/HEAD (defaults to rev_genesis if absent), plus the raw revision count.",
  {},
  () =>
    safe(async () => {
      const head = await ledger.getHead();
      const revisions = await ledger.readRevisions();
      return okStruct(`HEAD: ${head}`, { head, revision_count: revisions.length });
    })
);

server.tool(
  "gcl_commit",
  "Commit a durable revision: hash the named artifacts, append a content-addressed revision to the ledger, and CAS-advance HEAD. Ungated and declaration-based — it RECORDS provenance (self-reported), it does not enforce authority, protected namespaces, or an onboarding contract (those are fast-follow). Rejected with a CONFLICT if HEAD moved since expected_revision.",
  {
    actor: z.string().min(1).describe("Your per-interface coordination id (the committing agent)."),
    artifacts: z
      .array(
        z.object({
          path: z.string().min(1).describe("Workspace-relative path of a file to include (must already exist)."),
          lane: z.string().min(1).describe("Logical lane for this artifact, e.g. 'decisions', 'notes', 'project_state'."),
        })
      )
      .min(1)
      .describe("The files this revision commits; each is hashed at its current content."),
    expected_revision: z.string().optional().describe("Optimistic-concurrency guard: the HEAD you committed against. Omit to use current HEAD."),
    session: z.string().optional().describe("Optional session id for traceability."),
    provenance: z
      .object({
        originated_by: z.string().nullable().optional(),
        relayed_through: z.array(z.string()).optional(),
        posted_by: z.string().nullable().optional(),
        origin_ref: z.string().nullable().optional(),
        origin_excerpt: z.string().nullable().optional(),
        evidence_kind: z.string().nullable().optional(),
        authority_source: z.string().nullable().optional(),
        authority_scope: z.string().nullable().optional(),
        declared_lane: z.string().nullable().optional(),
        acted_lane: z.string().nullable().optional(),
      })
      .optional()
      .describe("Optional provenance DECLARATIONS (where content came from / under what stated authority). Recorded, not verified."),
  },
  (input) =>
    safe(async () => {
      const problem = await workspaceProblem();
      if (problem) return fail(problem);

      const expected = input.expected_revision ?? (await ledger.getHead());

      const arts: RevisionArtifact[] = [];
      for (const a of input.artifacts) {
        let content: string;
        try {
          content = await vault.read(a.path);
        } catch {
          return fail(`Cannot commit "${a.path}": no such file in the workspace. Write it first, then commit.`);
        }
        arts.push({ path: a.path, lane: a.lane, hash: sha256Text(content) });
      }
      const lanes = [...new Set(arts.map((a) => a.lane))].sort();

      const timestamp = new Date().toISOString();
      const commit_id = `cmt_${sha256Text(`${input.actor}:${timestamp}:${JSON.stringify(arts)}`).slice(0, 16)}`;

      // Principal is stamped from the trusted session boundary if configured, else honest self_report.
      const provenance: ActionProvenance = {
        principal_id: hasSessionPrincipal ? (sessionPrincipalId as string) : input.actor,
        principal_source: hasSessionPrincipal ? "connector_session" : "self_report",
        actor_identity: input.actor,
        ...(input.provenance ?? {}),
      };

      try {
        const record = await ledger.finalizeRevision(expected, {
          parent_revision: expected,
          commit_id,
          actor: input.actor,
          session: input.session ?? "",
          timestamp,
          artifacts: arts,
          lanes,
          spaces_contract_version: null,
          schema_version: STAMPED_FROM,
          provenance,
        });
        return okStruct(`Committed ${record.revision_id} (parent ${record.parent_revision}, ${arts.length} artifact(s))`, {
          ...record,
        });
      } catch (err) {
        if (err instanceof LedgerError && err.code === "CONFLICT") {
          return failStruct(
            `${err.message} HEAD moved to ${(err.detail?.actual_revision as string) ?? "?"}; re-read with gcl_head/gcl_readback and retry with the current HEAD.`,
            { conflict: true, ...(err.detail ?? {}) }
          );
        }
        throw err;
      }
    })
);

server.tool(
  "gcl_readback",
  "Read committed truth back from the ledger: the canonical HEAD and the reachable revision chain (oldest→newest), so you can verify what was committed and reconstruct context without reading the chat log. Unreachable entries (a crash between ledger-append and HEAD-advance) are reported separately as recovery candidates.",
  {
    limit: z.number().int().positive().optional().describe("Return only the most-recent N revisions of the chain (default: whole chain)."),
  },
  ({ limit }) =>
    safe(async () => {
      const problem = await workspaceProblem();
      if (problem) return fail(problem);
      const head = await ledger.getHead();
      const chain = await ledger.readReachableRevisions();
      const unreachable = await ledger.readUnreachableRevisions();
      const shown = limit ? chain.slice(-limit) : chain;
      const text =
        `HEAD ${head} · ${chain.length} reachable revision(s)` +
        (unreachable.length ? ` · ${unreachable.length} recovery candidate(s)` : "") +
        (shown.length ? `\nlatest: ${shown[shown.length - 1].revision_id}` : "");
      return okStruct(text, {
        head,
        reachable_count: chain.length,
        unreachable_count: unreachable.length,
        revisions: shown,
      });
    })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const { exists, isDirectory } = await vault.rootStatus();
  let health = "";
  if (!exists) health = "  ⚠ MISCONFIGURED: this path does not exist — set GCL_WORKSPACE and fully restart.";
  else if (!isDirectory) health = "  ⚠ MISCONFIGURED: this path is not a folder.";
  // Log to stderr so we never corrupt the stdio JSON-RPC stream on stdout.
  console.error(`[guided-context-ledger v${VERSION}] MCP connector running. Workspace: ${vault.root}${health}`);
}

main().catch((err) => {
  console.error("[guided-context-ledger] fatal:", err);
  process.exit(1);
});
