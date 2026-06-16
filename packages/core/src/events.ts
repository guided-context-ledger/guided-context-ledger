import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Event log — the AI-to-AI coordination layer.
 *
 * The markdown notes (see vault.ts) are the human layer and the source of
 * truth for documents. This module adds an append-only EVENT log for agent
 * coordination/handoff, because a shared markdown file is unsafe under
 * concurrent multi-agent writes (proven in the 2026-06-10 Claude↔Codex test).
 *
 * Design (validated against a multi-process hammer test):
 * - Storage: one append-only JSONL file per thread, plain files (portable, no DB).
 * - Cross-process safety: an exclusive lockfile around each append. Multiple
 *   server processes (one per client, e.g. Claude Desktop + Codex) write the
 *   same file, so an in-process mutex is NOT enough — the lockfile serializes
 *   appends across processes and prevents line interleaving even for large bodies.
 * - Ordering: the canonical `seq` is the line's 1-based ordinal at READ time.
 *   This sidesteps any cross-process "who got seq N" race — order is simply
 *   file order, assigned deterministically by the reader. `seq` is the cursor.
 * - Server stamps `created_at` (clients no longer invent ordering metadata).
 */

const THREAD_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const EVENT_TYPES = ["message", "ack", "handoff", "conflict", "claim"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Lifecycle states a `claim` event can assert over a work item. Ratified: the GCL coordination spec (codex). */
export const CLAIM_STATUSES = ["claimed", "released", "completed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Default lease window for a claim with no explicit lease_expires_at (interactive coordination work). */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000; // 30 min — codex #196; a default, not a protocol constant.

/**
 * Whether an event TYPE implies the addressee owes a response, when the writer
 * does not say explicitly. A handoff/conflict is an open obligation by default;
 * a message/ack is not. A claim is ownership, not an obligation on others.
 * Ratified: the GCL coordination spec (codex).
 */
const RESPONSE_REQUIRED_BY_TYPE: Record<EventType, boolean> = {
  message: false,
  ack: false,
  handoff: true,
  conflict: true,
  claim: false,
};
function defaultRequiresResponse(type: EventType): boolean {
  return RESPONSE_REQUIRED_BY_TYPE[type] ?? false;
}
/** Normalize an addressed_to list: trimmed, non-empty, de-duplicated, order-stable. */
function normalizeActors(list: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const MAX_BODY = 200_000; // safety cap on a single event body
const LOCK_TIMEOUT_MS = 5_000; // give up acquiring the lock after this
const LOCK_STALE_MS = 4_000; // a lock older than this is considered abandoned
const MAX_WAIT_MS = 50_000; // long-poll cap (must stay under client tool timeouts)
const POLL_INTERVAL_MS = 400;

export class EventError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "EventError";
  }
}

export interface AgentEvent {
  seq: number;
  event_id: string;
  thread: string;
  actor: string;
  type: EventType;
  parent_event_id: string | null;
  created_at: string;
  body: string;
  /** Coordination actor ids this event is directed at (NOT humans/principals). Empty = unaddressed. */
  addressed_to: string[];
  /** Whether an addressee owes a causal response. Defaults by type when unstated (see RESPONSE_REQUIRED_BY_TYPE). */
  requires_response: boolean;
  /** For type=claim only: the lifecycle assertion. null for non-claim events. */
  claim_status: ClaimStatus | null;
  /** For type=claim only: ISO-8601 lease end, or null for an indefinite hold. */
  lease_expires_at: string | null;
}

/** Optional structured addressing / claim payload for an appended event. */
export interface AppendOptions {
  /** Coordination actor ids this event is directed at. Use even for one recipient. */
  addressedTo?: string[];
  /** Override the type-derived default for whether the addressee owes a response. */
  requiresResponse?: boolean;
  /** For type=claim: the lifecycle assertion (claimed|released|completed). Required when type=claim. */
  claimStatus?: ClaimStatus;
  /**
   * For type=claim with claimStatus=claimed: ISO-8601 lease end. Omitted → server stamps
   * created_at + DEFAULT_LEASE_MS. Pass null explicitly for an indefinite hold (no expiry).
   */
  leaseExpiresAt?: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class EventLog {
  readonly root: string; // vault root
  readonly dir: string; // events directory inside the vault

  constructor(vaultRoot: string) {
    this.root = path.resolve(vaultRoot);
    this.dir = path.join(this.root, "events");
  }

  private threadFile(thread: string): string {
    if (!THREAD_RE.test(thread)) {
      throw new EventError(
        `Invalid thread id "${thread}". Allowed: letters, digits, dot, underscore, hyphen; max 128 chars.`,
        "BAD_THREAD"
      );
    }
    const file = path.join(this.dir, `${thread}.jsonl`);
    const rel = path.relative(this.dir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new EventError(`Thread escapes the events directory: ${thread}`, "BAD_THREAD");
    }
    return file;
  }

  /** The vault root must already exist — we never silently create it. */
  private async assertRoot(): Promise<void> {
    try {
      const s = await fs.stat(this.root);
      if (!s.isDirectory()) throw new EventError(`Vault path is not a folder: ${this.root}`, "VAULT_NOT_DIR");
    } catch (e) {
      if (e instanceof EventError) throw e;
      throw new EventError(`Vault folder does not exist: ${this.root}`, "VAULT_MISSING");
    }
  }

  private async acquireLock(lock: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        const fd = await fs.open(lock, "wx"); // exclusive create; fails if held
        await fd.writeFile(`${process.pid}:${Date.now()}`);
        await fd.close();
        return;
      } catch (e: any) {
        const lockBusy = e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES";
        if (!lockBusy) throw e;
        // Steal an abandoned lock (a process that crashed mid-append). On
        // Windows, concurrent exclusive opens can transiently surface as
        // EPERM/EACCES while another handle is settling; treat that as busy.
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lock).catch(() => {});
            continue;
          }
        } catch {
          if (e.code === "EEXIST") continue; // lock vanished between checks.
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new EventError("Could not acquire the thread write lock (busy).", "LOCK_TIMEOUT");
        }
        await sleep(2 + Math.floor(Math.random() * 8));
      }
    }
  }

  private async releaseLock(lock: string): Promise<void> {
    await fs.unlink(lock).catch(() => {});
  }

  private async countLines(file: string): Promise<number> {
    try {
      const c = await fs.readFile(file, "utf8");
      return c.split("\n").filter((l) => l.length > 0).length;
    } catch (e: any) {
      if (e.code === "ENOENT") return 0;
      throw e;
    }
  }

  /**
   * Append one event. Server-stamps created_at. Returns the assigned seq
   * (line ordinal) and a stable event_id. Cross-process safe via the lockfile.
   */
  async append(
    thread: string,
    actor: string,
    body: string,
    type: EventType = "message",
    parentEventId: string | null = null,
    opts: AppendOptions = {}
  ): Promise<{ seq: number; event_id: string; created_at: string }> {
    await this.assertRoot();
    if (!actor || !actor.trim()) throw new EventError("actor is required.", "BAD_ACTOR");
    if (!EVENT_TYPES.includes(type)) {
      throw new EventError(`Invalid type "${type}". Allowed: ${EVENT_TYPES.join(", ")}.`, "BAD_TYPE");
    }
    if (typeof body !== "string") throw new EventError("body must be a string.", "BAD_BODY");
    if (body.length > MAX_BODY) {
      throw new EventError(`body too large (${body.length} > ${MAX_BODY} chars).`, "BODY_TOO_LARGE");
    }

    const file = this.threadFile(thread);
    const lock = `${file}.lock`;
    await fs.mkdir(this.dir, { recursive: true });
    const created_at = new Date().toISOString();

    const addressed_to = normalizeActors(opts.addressedTo);
    const requires_response =
      typeof opts.requiresResponse === "boolean" ? opts.requiresResponse : defaultRequiresResponse(type);

    // Claim fields: only meaningful for type=claim. A claim MUST reference the work item
    // it claims via parent_event_id (codex #196.1) and MUST carry a claim_status.
    let claim_status: ClaimStatus | null = null;
    let lease_expires_at: string | null = null;
    if (type === "claim") {
      if (!parentEventId) {
        throw new EventError("a claim event must reference the work item via parent_event_id.", "CLAIM_NO_PARENT");
      }
      if (!opts.claimStatus || !CLAIM_STATUSES.includes(opts.claimStatus)) {
        throw new EventError(
          `a claim event needs claim_status (one of: ${CLAIM_STATUSES.join(", ")}).`,
          "BAD_CLAIM_STATUS"
        );
      }
      claim_status = opts.claimStatus;
      if (claim_status === "claimed") {
        // Omitted → default lease; explicit null → indefinite hold; explicit string → validate ISO.
        if (opts.leaseExpiresAt === undefined) {
          lease_expires_at = new Date(Date.parse(created_at) + DEFAULT_LEASE_MS).toISOString();
        } else if (opts.leaseExpiresAt === null) {
          lease_expires_at = null;
        } else if (Number.isNaN(Date.parse(opts.leaseExpiresAt))) {
          throw new EventError(`lease_expires_at is not a valid ISO-8601 timestamp: ${opts.leaseExpiresAt}`, "BAD_LEASE");
        } else {
          lease_expires_at = new Date(Date.parse(opts.leaseExpiresAt)).toISOString();
        }
      }
    }

    await this.acquireLock(lock);
    try {
      const record = {
        actor,
        type,
        parent_event_id: parentEventId,
        created_at,
        body,
        addressed_to,
        requires_response,
        claim_status,
        lease_expires_at,
      };
      // One newline-terminated JSON line; the lock guarantees no interleave.
      await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
      const seq = await this.countLines(file);
      const event_id = `${thread}#${seq}`;
      await this.touchPresence(actor, created_at); // best-effort
      return { seq, event_id, created_at };
    } finally {
      await this.releaseLock(lock);
    }
  }

  private parseLine(thread: string, line: string, seq: number): AgentEvent | null {
    try {
      const o = JSON.parse(line);
      const type = (o.type ?? "message") as EventType;
      return {
        seq,
        event_id: `${thread}#${seq}`,
        thread,
        actor: String(o.actor ?? "unknown"),
        type,
        parent_event_id: o.parent_event_id ?? null,
        created_at: String(o.created_at ?? ""),
        body: String(o.body ?? ""),
        // Legacy events predate structured addressing: absent → unaddressed, and
        // requires_response falls back to the type default (so old handoffs still read as open).
        addressed_to: normalizeActors(o.addressed_to),
        requires_response:
          typeof o.requires_response === "boolean" ? o.requires_response : defaultRequiresResponse(type),
        // Claim fields only carry meaning for type=claim; absent/invalid → null (legacy events have neither).
        claim_status:
          type === "claim" && CLAIM_STATUSES.includes(o.claim_status) ? (o.claim_status as ClaimStatus) : null,
        lease_expires_at:
          type === "claim" && typeof o.lease_expires_at === "string" ? o.lease_expires_at : null,
      };
    } catch {
      return null;
    }
  }

  private async readRaw(
    thread: string,
    afterSeq: number
  ): Promise<{ events: AgentEvent[]; latest_seq: number; corrupt: number }> {
    const file = this.threadFile(thread);
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return { events: [], latest_seq: 0, corrupt: 0 };
      throw e;
    }
    const lines = content.split("\n").filter((l) => l.length > 0);
    const events: AgentEvent[] = [];
    let corrupt = 0;
    lines.forEach((l, i) => {
      const seq = i + 1;
      if (seq <= afterSeq) return;
      const ev = this.parseLine(thread, l, seq);
      if (ev) events.push(ev);
      else corrupt++;
    });
    return { events, latest_seq: lines.length, corrupt };
  }

  /**
   * Read events with seq > afterSeq (the cursor → only deltas). If waitMs > 0
   * and there are no new events, long-poll: re-check until new events arrive or
   * the wait elapses (collapses idle polling into one call). Pass `actor` to
   * record presence (so peers can tell you are alive even while only reading).
   */
  async read(
    thread: string,
    afterSeq = 0,
    waitMs = 0,
    actor?: string
  ): Promise<{ events: AgentEvent[]; latest_seq: number; corrupt: number; presence: Record<string, string> }> {
    await this.assertRoot();
    if (actor && actor.trim()) await this.touchPresence(actor, new Date().toISOString()).catch(() => {});
    const wait = Math.max(0, Math.min(waitMs || 0, MAX_WAIT_MS));
    const start = Date.now();
    let res = await this.readRaw(thread, afterSeq);
    while (res.events.length === 0 && Date.now() - start < wait) {
      await sleep(POLL_INTERVAL_MS);
      res = await this.readRaw(thread, afterSeq);
    }
    const presence = await this.readPresence();
    return { ...res, presence };
  }

  /** Advisory last-active map; last-write-wins (races tolerable, parse errors reset). */
  private async touchPresence(actor: string, iso: string): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const p = path.join(this.dir, "_presence.json");
      let cur: Record<string, string> = {};
      try {
        cur = JSON.parse(await fs.readFile(p, "utf8"));
      } catch {
        cur = {};
      }
      cur[actor] = iso;
      await fs.writeFile(p, JSON.stringify(cur), "utf8");
    } catch {
      /* presence is best-effort; never fail a real operation over it */
    }
  }

  private async readPresence(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, "_presence.json"), "utf8"));
    } catch {
      return {};
    }
  }

  /** List thread ids that have an event log. */
  async listThreads(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries
        .filter((e) => e.endsWith(".jsonl"))
        .map((e) => e.slice(0, -".jsonl".length))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Cross-thread overview for `orient`: per-thread cursor state relative to
   * `actor` (deterministic, no inference). `unread` = events after the actor's
   * own last post; `needs_me` flags threads whose latest event is from someone
   * else and is unread by the actor. Records presence for the actor.
   */
  async overview(actor?: string): Promise<{
    threads: ThreadOverview[];
    open_for_me: OpenForMeItem[];
    presence: Record<string, string>;
  }> {
    if (actor && actor.trim()) await this.touchPresence(actor, new Date().toISOString()).catch(() => {});
    const presence = await this.readPresence();
    const knownActors = Object.keys(presence); // bounded source for the prose-handoff heuristic
    const names = await this.listThreads();
    const now = Date.now(); // single read-time clock for all lease-expiry comparisons this orient
    const threads: ThreadOverview[] = [];
    const openForMe: OpenForMeItem[] = [];
    for (const t of names) {
      const { events, latest_seq } = await this.readRaw(t, 0);
      let myLast = 0;
      if (actor) for (const e of events) if (e.actor === actor) myLast = e.seq;
      const last = events.length ? events[events.length - 1] : null;
      const unread = latest_seq - myLast;

      // Ownership projection: fold the thread's claim events per work item (read-time
      // expiry, no ledger mutation). Used to suppress items owned by another actor and
      // to surface the orienting actor's own owned items as in-progress.
      const claimsByWorkItem = projectClaims(events, now);

      // Open responsibilities directed at this actor: addressed AND requires_response,
      // not yet causally answered by the actor. Structured addressed_to is canonical;
      // a prose "@actor" mention in a handoff is a labelled lower-confidence bridge for
      // legacy/unstructured handoffs (source=heuristic).
      const threadOpen: OpenForMeItem[] = [];
      if (actor) {
        const childrenByParent = indexChildren(events);
        for (const e of events) {
          if (e.actor === actor) continue; // you don't owe yourself a response
          const addr = addresseesFor(e, actor, knownActors);
          if (!addr.matched || !e.requires_response) continue;
          if (actorRespondedCausally(childrenByParent, e, actor)) continue;

          // Claim gate. An unexpired claim by SOMEONE ELSE suppresses the item (the race fix:
          // the second eligible actor no longer sees it as unclaimed work). A live claim by ME
          // surfaces the item as owned/in-progress. An expired (stale) claim does NOT suppress —
          // the item re-enters the pool and is re-claimable, with the stale owner surfaced.
          const cs = claimsByWorkItem.get(e.event_id);
          let claim: OpenForMeItem["claim"];
          if (cs && cs.owner) {
            if (!cs.stale && cs.owner !== actor) continue; // owned by another, lease live → suppress
            claim = { status: "claimed", claimed_by: cs.owner, expires: cs.expires, stale: cs.stale, mine: cs.owner === actor };
          }

          threadOpen.push({
            thread: t,
            seq: e.seq,
            event_id: e.event_id,
            actor: e.actor,
            type: e.type,
            summary: firstLine(e.body),
            source: addr.source,
            ...(claim ? { claim } : {}),
          });
        }
      }
      openForMe.push(...threadOpen);

      threads.push({
        thread: t,
        latest_seq,
        my_last_seq: myLast,
        unread,
        last_event: last
          ? { seq: last.seq, actor: last.actor, type: last.type, summary: firstLine(last.body) }
          : null,
        // An open obligation always needs me. Otherwise: there is unread from someone
        // else, but a terminal event closes the loop — an ack (don't ping-pong on "you
        // acked my ack") or a claim (someone taking ownership isn't a ping for me).
        needs_me:
          threadOpen.length > 0 ||
          (!!last && last.actor !== actor && unread > 0 && last.type !== "ack" && last.type !== "claim"),
        open_for_me: threadOpen.length,
      });
    }
    return { threads, open_for_me: openForMe, presence };
  }
}

/** Build a parent_event_id → children map for causal descent within one thread. */
function indexChildren(events: AgentEvent[]): Map<string, AgentEvent[]> {
  const m = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (!e.parent_event_id) continue;
    const arr = m.get(e.parent_event_id);
    if (arr) arr.push(e);
    else m.set(e.parent_event_id, [e]);
  }
  return m;
}

/**
 * True if `actor` posted any non-claim event causally descended from `e` — a real response
 * that closes the obligation. A `claim` is deliberately excluded: claiming work means "I'm
 * taking this, will respond later," so it must NOT close the item — otherwise the claimant's
 * own owned work would vanish from their open_for_me instead of surfacing as in-progress.
 */
function actorRespondedCausally(childrenByParent: Map<string, AgentEvent[]>, e: AgentEvent, actor: string): boolean {
  const stack = [...(childrenByParent.get(e.event_id) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d.event_id)) continue;
    seen.add(d.event_id);
    if (d.actor === actor && d.type !== "claim") return true;
    const kids = childrenByParent.get(d.event_id);
    if (kids) stack.push(...kids);
  }
  return false;
}

/** Projected ownership of a work item, folded from its claim events at read time. */
export interface ClaimState {
  /** Current owner actor, or null if unclaimed / released / completed. */
  owner: string | null;
  /** The owner's lease end (ISO-8601), or null for an indefinite hold. */
  expires: string | null;
  /** True when an owner holds the item but the lease has lapsed vs the read clock — re-claimable. */
  stale: boolean;
  /** Latest lifecycle status seen for the item (claimed while owned; released/completed when freed). */
  status: ClaimStatus | null;
}

/**
 * Fold the thread's `claim` events into per-work-item ownership. Replayed in seq order:
 *  - first-seq-wins among live claims; a competing actor's claim is ignored while the owner's lease holds;
 *  - a same-actor claim renews/extends (latest lease wins); release/completed by the owner frees the item;
 *  - takeover by another actor is honoured only if the prior owner's lease had lapsed by that claim's time
 *    (an abandoned hold), which is exactly how a stale claim becomes re-claimable on the trail.
 * Expiry against `now` is applied last, as a read-time projection — never written back (codex #196.3/.4).
 */
function projectClaims(events: AgentEvent[], now: number): Map<string, ClaimState> {
  const byParent = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (e.type !== "claim" || !e.parent_event_id || !e.claim_status) continue;
    const arr = byParent.get(e.parent_event_id);
    if (arr) arr.push(e);
    else byParent.set(e.parent_event_id, [e]);
  }

  const out = new Map<string, ClaimState>();
  for (const [workItem, claims] of byParent) {
    let owner: string | null = null;
    let expires: string | null = null;
    let status: ClaimStatus | null = null;
    for (const c of claims) {
      // events are in seq order; readRaw never reorders
      if (owner === null) {
        if (c.claim_status === "claimed") {
          owner = c.actor;
          expires = c.lease_expires_at;
          status = "claimed";
        } else {
          status = c.claim_status; // released/completed with nothing held — record terminal status
        }
      } else if (c.actor === owner) {
        if (c.claim_status === "claimed") {
          expires = c.lease_expires_at; // renewal: latest same-actor lease wins
        } else {
          owner = null; // owner released/completed
          expires = null;
          status = c.claim_status;
        }
      } else {
        // different actor: takeover only if the current lease had already lapsed when they claimed
        if (c.claim_status === "claimed" && expires !== null && Date.parse(expires) <= Date.parse(c.created_at)) {
          owner = c.actor;
          expires = c.lease_expires_at;
          status = "claimed";
        }
        // otherwise first-seq-wins (live owner holds); a non-owner release/completed is ignored
      }
    }
    const stale = owner !== null && expires !== null && Date.parse(expires) <= now;
    out.set(workItem, { owner, expires, stale, status });
  }
  return out;
}

/** Whether event `e` is directed at `actor`: structured addressed_to wins; a prose @mention on a handoff is the heuristic bridge. */
function addresseesFor(
  e: AgentEvent,
  actor: string,
  knownActors: string[]
): { matched: boolean; source: "structured" | "heuristic" } {
  if (e.addressed_to.length) {
    return { matched: e.addressed_to.includes(actor), source: "structured" };
  }
  // No structured addressing: only a handoff carries a prose obligation worth bridging.
  if (e.type === "handoff" && knownActors.includes(actor) && mentions(e.body, actor)) {
    return { matched: true, source: "heuristic" };
  }
  return { matched: false, source: "structured" };
}

/**
 * Heuristic bridge for legacy/prose handoffs — matches only a DIRECTED address to
 * the actor, never a bare mention in arbitrary prose. Accepted forms (codex ruling,
 * the GCL coordination spec):
 *   - "@actor"                     (@-mention)
 *   - "→ actor" / "-> actor"       (arrow)
 *   - "actor:" / "actor (role):" / "actor / role:" at the start of a line (directed header)
 * All are whole-token, so "claude-coder" never matches "claude-code". Bare mid-prose
 * names (e.g. "...closed the codex, claude-code, and Gemini sessions" or "owned by
 * claude-code") are rejected — departure/sign-off handoffs list actors without
 * assigning the event to them, and stale false-positives pollute open_for_me. The
 * bridge is a transition aid only; structured addressed_to is canonical going forward,
 * so a false negative on ambiguous old prose is safer than a false positive.
 */
function mentions(body: string, actor: string): boolean {
  const a = escapeRe(actor);
  const rb = `(?![A-Za-z0-9_-])`; // right token boundary — no id char may follow
  const forms = [
    new RegExp(`@${a}${rb}`, "i"), // @actor
    new RegExp(`(?:→|->)\\s*${a}${rb}`, "i"), // → actor / -> actor
    // directed header at line start: "actor:", "actor (role):", "actor / role:"
    new RegExp(`(?:^|\\n)[ \\t]*${a}${rb}(?:\\s*\\([^)\\n]*\\)|\\s*/\\s*[^:\\n]+)?\\s*:`, "i"),
  ];
  return forms.some((re) => re.test(body));
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ThreadOverview {
  thread: string;
  latest_seq: number;
  my_last_seq: number;
  unread: number;
  last_event: { seq: number; actor: string; type: EventType; summary: string } | null;
  needs_me: boolean;
  /** Count of open responsibilities directed at the orienting actor in this thread. */
  open_for_me: number;
}

/** One open responsibility directed at the orienting actor (an unanswered, response-requiring address). */
export interface OpenForMeItem {
  thread: string;
  seq: number;
  event_id: string;
  /** Who addressed the actor (the event author). */
  actor: string;
  type: EventType;
  summary: string;
  /** structured = explicit addressed_to; heuristic = prose @mention bridge (lower confidence). */
  source: "structured" | "heuristic";
  /**
   * Present when the item has been claimed. Items live-claimed by ANOTHER actor are suppressed
   * (absent from open_for_me); this surfaces only items the actor owns (`mine: true`) or whose
   * claim has gone stale (`stale: true`, re-claimable).
   */
  claim?: {
    status: "claimed";
    claimed_by: string;
    /** ISO-8601 lease end, or null for an indefinite hold. */
    expires: string | null;
    /** True when the lease lapsed vs the read clock — re-claimable. */
    stale: boolean;
    /** True when the orienting actor is the owner. */
    mine: boolean;
  };
}

function firstLine(s: string): string {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}
