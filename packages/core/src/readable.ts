import type { AgentEvent, EventType, TaskStatus } from "./events.js";

/**
 * Human-readable projection (P0-1 — the "inspectability" claim; crucible:main#22–#27).
 *
 * The event log (`events/<thread>.jsonl`) is the SOURCE OF TRUTH; this module renders a durable,
 * human-readable `.md` projection ALONGSIDE it, so a human can inspect what happened — decisions,
 * open loops, task state, handoffs, provenance, sequencing — WITHOUT asking an agent to summarize
 * and without spelunking raw JSON. Machine truth below, readable projection beside it.
 *
 * This restores PAIL's Projection-Forward Invariant (`.pail` = truth, `.md` = generated view), which
 * the droplet event-thread migration dropped. These functions are PURE (events → markdown string) so
 * they are trivially testable; EventLog owns the file IO and the post-append render hook.
 */

/** A row in the readable INDEX.md — one per thread, computed from that thread's events. */
export interface IndexRow {
  thread: string;
  event_count: number;
  /** ISO timestamp of the last event, or null for an empty thread. */
  last_activity: string | null;
  /** Author + type + summary of the latest event (for the "Latest event" column). */
  latest_actor: string | null;
  latest_type: EventType | null;
  latest_summary: string;
}

const GENERATED_BANNER = "**Generated view — do not edit.**";

/** ISO `2026-07-08T01:50:18.458Z` → readable `2026-07-08 01:50:18 UTC`. Deterministic (no Date parse). */
function fmtTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso ?? "");
  return m ? `${m[1]} ${m[2]} UTC` : (iso && iso.trim() ? iso : "(no timestamp)");
}

/** First non-empty line, trimmed and length-capped — the one-line summary used in headings/the index. */
function firstLine(s: string, cap = 160): string {
  const line = ((s ?? "").split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return line.length > cap ? line.slice(0, cap) + "…" : line;
}

/** Escape a value for a single markdown table cell (pipes + newlines would break the row). */
function cell(s: string): string {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * Fold task terminal truth thread-locally (first-terminal-wins, mirroring events.ts projectTasks) so a
 * `task` creation event can be annotated with its CURRENT state (open/completed/cancelled). Thread-local
 * is sufficient here — a task's lifecycle events live in the same thread as its creation.
 */
function foldTaskTruth(events: AgentEvent[]): Map<string, TaskStatus | "open"> {
  const truth = new Map<string, TaskStatus | "open">();
  for (const e of events) if (e.type === "task") truth.set(e.event_id, "open");
  for (const e of events) {
    if (e.type !== "task_state" || !e.parent_event_id || !e.task_status) continue;
    // First terminal settles it; later terminal attempts are ignored (immutable truth).
    if (truth.get(e.parent_event_id) === "open") truth.set(e.parent_event_id, e.task_status);
  }
  return truth;
}

/** The compact italic metadata line under an event heading — only the parts that are present. */
function metaLine(e: AgentEvent): string {
  const parts: string[] = [];
  // Attribution beyond the executing surface (already in the heading): the accountable human + the relay.
  if (e.principal) parts.push(`by ${e.principal}`);
  if (e.mediated_by) parts.push(`via ${e.mediated_by}`);
  if (e.parent_event_id) parts.push(`↳ re: ${e.parent_event_id}`);
  if (e.addressed_to.length) parts.push(`→ to: ${e.addressed_to.join(", ")}`);
  if (e.requires_response) parts.push("• awaiting response");
  const resolves = e.resolves ?? []; // optional on the public AgentEvent (tolerant-read provenance)
  if (resolves.length) parts.push(`✓ closes: ${resolves.join(", ")}`);
  return parts.join(" · ");
}

/** The type-specific badge line (task family / claim) — the structured facts a human needs at a glance. */
function badgeLine(e: AgentEvent, taskTruth: Map<string, TaskStatus | "open">): string {
  switch (e.type) {
    case "task": {
      const bits: string[] = [];
      if (e.task_title) bits.push(`"${e.task_title}"`);
      bits.push(`state: ${taskTruth.get(e.event_id) ?? "open"}`);
      if (e.requires.length) bits.push(`requires: ${e.requires.join(", ")}`);
      if (e.role) bits.push(`role: ${e.role}`);
      if (e.scope?.project) bits.push(`project: ${e.scope.project}`);
      if (e.succeeds) bits.push(`succeeds ${e.succeeds} (${e.succession ?? "?"})`);
      if (e.due_date) bits.push(`due: ${e.due_date}`);
      return `**task** ${bits.join(" · ")}`;
    }
    case "task_state":
      return `**task_state** → ${e.task_status}${e.reason ? ` — ${firstLine(e.reason)}` : ""}`;
    case "task_authorization":
      return `**task_authorization** → ${e.authorization}${e.reason ? ` — ${firstLine(e.reason)}` : ""}`;
    case "task_condition":
      return `**task_condition** ${e.condition_state}${e.condition ? ` ${e.condition}` : ""}${e.reason ? ` — ${firstLine(e.reason)}` : ""}`;
    case "claim":
      return `**claim** → ${e.claim_status}${e.lease_expires_at ? ` (lease ${fmtTime(e.lease_expires_at)})` : ""}`;
    default:
      return "";
  }
}

/** Render one event to its markdown block: heading · meta · badge · prose body. */
function renderEvent(e: AgentEvent, taskTruth: Map<string, TaskStatus | "open">): string {
  const out: string[] = [];
  out.push(`### ${e.event_id} · ${e.actor} · ${e.type} · ${fmtTime(e.created_at)}`);
  const meta = metaLine(e);
  if (meta) out.push(`*${meta}*`);
  const badge = badgeLine(e, taskTruth);
  if (badge) out.push(badge);
  out.push(""); // blank line before the body so markdown renders the prose as its own block
  out.push((e.body ?? "").trimEnd() || "_(no body)_");
  return out.join("\n");
}

/**
 * Render a full thread to a durable human-readable markdown projection. `events` are in seq order as
 * returned by EventLog.readRaw (the reader assigns seq = line ordinal). The header states the machine
 * event log is authoritative and points back to it (the refs-to-machine-truth requirement, main#26).
 */
export function renderThreadMarkdown(thread: string, events: AgentEvent[]): string {
  const taskTruth = foldTaskTruth(events);
  const last = events.length ? events[events.length - 1] : null;
  const lastActivity = last ? fmtTime(last.created_at) : "—";

  const header = [
    `# ${thread} — readable projection`,
    "",
    `> ${GENERATED_BANNER} Source of truth: \`events/${thread}.jsonl\` (the append-only event log is authoritative; this \`.md\` is a rendered projection of it). Regenerated on every append.`,
    `> ${events.length} event${events.length === 1 ? "" : "s"} · last activity ${lastActivity} · [← all threads](INDEX.md)`,
    "",
    "---",
    "",
    "",
  ].join("\n");

  if (!events.length) {
    return header + "_No events yet._\n";
  }
  const body = events.map((e) => renderEvent(e, taskTruth)).join("\n\n");
  return header + body + "\n";
}

/** Compute the INDEX row for a thread from its events (latest event drives the summary column). */
export function indexRowFromEvents(thread: string, events: AgentEvent[]): IndexRow {
  const last = events.length ? events[events.length - 1] : null;
  return {
    thread,
    event_count: events.length,
    last_activity: last ? last.created_at : null,
    latest_actor: last ? last.actor : null,
    latest_type: last ? last.type : null,
    latest_summary: last ? firstLine(last.body) : "",
  };
}

/**
 * Render the readable INDEX.md — one table row per thread, sorted by last activity (most recent first),
 * each thread name linking to its per-thread projection. The human's front door to the coordination layer.
 */
export function renderIndexMarkdown(workspaceLabel: string, rows: IndexRow[]): string {
  const sorted = [...rows].sort((a, b) => {
    const ax = a.last_activity ?? "";
    const bx = b.last_activity ?? "";
    return ax < bx ? 1 : ax > bx ? -1 : a.thread < b.thread ? -1 : 1; // most-recent first, tie → name
  });
  const totalEvents = rows.reduce((n, r) => n + r.event_count, 0);

  const out: string[] = [];
  out.push(`# ${workspaceLabel} — coordination threads (readable projection)`);
  out.push("");
  out.push(`> ${GENERATED_BANNER} Source of truth: \`events/*.jsonl\`. Regenerated on every append; a human can inspect the full coordination state here without an agent.`);
  out.push(`> ${rows.length} thread${rows.length === 1 ? "" : "s"} · ${totalEvents} event${totalEvents === 1 ? "" : "s"} total.`);
  out.push("");
  out.push("| Thread | Events | Last activity | Latest event |");
  out.push("| --- | ---: | --- | --- |");
  for (const r of sorted) {
    const latest = r.latest_actor
      ? `${r.latest_actor} · ${r.latest_type}: ${r.latest_summary}`
      : "—";
    out.push(
      `| [${cell(r.thread)}](${encodeURIComponent(r.thread)}.md) | ${r.event_count} | ${r.last_activity ? fmtTime(r.last_activity) : "—"} | ${cell(latest)} |`
    );
  }
  out.push("");
  return out.join("\n");
}
