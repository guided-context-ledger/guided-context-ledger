import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Event log — the AI-to-AI coordination layer.
 *
 * The markdown notes (see workspace.ts) are the human layer and the source of
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
export const EVENT_TYPES = [
  "message",
  "ack",
  "handoff",
  "conflict",
  "claim",
  // Capability-routed task pool (the GCL coordination spec).
  "task", // creation: task_id := event_id; born unassigned (§2.0). Forward work = a typed successor task (succeeds/succession), never a reopen.
  "task_state", // truth lifecycle: completed | cancelled — both TERMINAL & IMMUTABLE (no reopen; reopening is tampering)
  "task_authorization", // human assignment: approved | revoked — changes claim eligibility, not truth
  "task_condition", // declared condition assertion: pending | blocked, set/cleared (the author-declared half of the conditions axis)
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Lifecycle states a `claim` event can assert over a work item. Ratified: the GCL coordination spec (codex). */
export const CLAIM_STATUSES = ["claimed", "released", "completed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * Truth lifecycle a `task_state` event asserts over a task. Distinct from claim ownership (§2.3).
 * Both values are TERMINAL and IMMUTABLE: once a task is completed or cancelled its truth is settled
 * for good. There is deliberately no `reopened` — reopening a closed task retroactively mutates a
 * recorded completion, which is tampering with the append-only truth trail (Kyle, 2026-06-19). Forward
 * work is a NEW successor task that references the original (see SUCCESSION_RELATIONS), yielding a
 * visible lineage chain instead of a muddied open/close/open history.
 */
export const TASK_STATUSES = ["completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * How a successor task relates to the original it supersedes (forward work after a terminal close,
 * GCL-State-Model §"Task re-opening"). The relation tells an observer WHY a closed task reappeared:
 *  - `continuation` — a clean follow-on; the original finished and this carries it forward.
 *  - `redo`         — the original regressed or proved insufficient; redo the work.
 *  - `correction`   — the original was closed in error or is disputed; this corrects the record.
 * Carried on the SUCCESSOR's creation event via `succeeds` (the original task_id) + `succession`.
 */
export const SUCCESSION_RELATIONS = ["continuation", "redo", "correction"] as const;
export type SuccessionRelation = (typeof SUCCESSION_RELATIONS)[number];

/**
 * Conditions an item can carry (GCL-State-Model §"The dimensions" axis 3). FACTS ONLY — the system
 * reports facts, the human assigns meaning (facts-vs-meaning, locked). Conditions STACK and each carries
 * an inspectable reason. They are orthogonal to lifecycle (an in-progress task can become blocked/stale).
 *  - `overdue`      — DERIVED fact: now is past `due_date` (zero-threshold, no "soon" opinion).
 *  - `stale`        — DERIVED fact: no qualifying/semantic-transition activity within the cadence window.
 *  - `pending`      — DECLARED: a decision/input is awaited but a path forward exists (the ball is in
 *                     someone's court who CAN act). Author-set; no auto-derivation mechanism in v0.
 *  - `blocked`      — DECLARED: a hard stop (missing parts/upstream/broken) — cannot proceed regardless.
 *                     Author-set; no auto-derivation mechanism in v0.
 *  - `undetermined` — honest fallback: a determination was expected but inputs are missing (e.g. no
 *                     `due_date` → can't assess overdue). Distinct from *clear*; quiet, not an alarm.
 * v0 auto-emits only the two purely-derived facts (`overdue`, `stale`); `pending`/`blocked` await a
 * declaration mechanism and `undetermined` is emitted only where a determination is genuinely expected.
 */
export const TASK_CONDITIONS = ["pending", "blocked", "overdue", "stale", "undetermined"] as const;
export type TaskCondition = (typeof TASK_CONDITIONS)[number];

/**
 * The DECLARED conditions — the author-set subset of the conditions axis (the rest are derived facts).
 * `pending` (a decision/input is awaited but a path forward exists) vs `blocked` (a hard stop). Declared
 * via a `task_condition` event, not derived, because intent isn't computable from timestamps.
 */
export const DECLARABLE_CONDITIONS = ["pending", "blocked"] as const;
export type DeclarableCondition = (typeof DECLARABLE_CONDITIONS)[number];

/** A `task_condition` event either asserts a condition (`set`) or retracts a specific prior assertion (`cleared`). */
export const CONDITION_STATES = ["set", "cleared"] as const;
export type ConditionState = (typeof CONDITION_STATES)[number];

/**
 * One ACTIVE declared-condition assertion on a task (a `set` not yet `cleared`). Assertion identity is the
 * `set` event's id, so clearing one actor's blocker can't erase another's independent blocker (codex
 * the GCL coordination spec). Each carries its own author + reason.
 */
export interface DeclaredCondition {
  assertion_id: string;
  condition: DeclarableCondition;
  reason: string;
  actor: string;
  since: string;
}

/** A condition fact plus the inspectable reason behind it (reasons render in the surface, not just provenance). */
export interface ConditionFlag {
  condition: TaskCondition;
  reason: string;
}

/** A `task_authorization` event's assertion. `approved` makes a task claim-eligible; `revoked` withdraws it. */
export const TASK_AUTHORIZATIONS = ["approved", "revoked"] as const;
export type TaskAuthorization = (typeof TASK_AUTHORIZATIONS)[number];

/**
 * Workspace pull policy — gates autonomous CLAIM eligibility over the pool, never visibility.
 * Default `human_directed` (unassigned-by-default; Kyle #239 / codex #242). A default, not a constant.
 */
export const TASK_PULL_POLICIES = ["human_directed", "proactive_until_stale", "proactive"] as const;
export type TaskPullPolicy = (typeof TASK_PULL_POLICIES)[number];
export const DEFAULT_TASK_PULL_POLICY: TaskPullPolicy = "human_directed";

/** Optional scope envelope on a task. v0 matches project/space; principal_scope is opaque (OI-001 deferred). */
export interface TaskScope {
  project?: string;
  space?: string;
  principal_scope?: string;
}

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
  // A task is an open obligation on the pool until terminally closed (its whole point: the need
  // never gets lost). task_state/task_authorization are bookkeeping, not obligations on others.
  task: true,
  task_state: false,
  task_authorization: false,
  task_condition: false,
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

/** Normalize a task scope envelope: keep only non-empty string members; null if nothing survives. */
function normalizeScope(s: unknown): TaskScope | null {
  if (!s || typeof s !== "object") return null;
  const src = s as Record<string, unknown>;
  const out: TaskScope = {};
  if (typeof src.project === "string" && src.project.trim()) out.project = src.project.trim();
  if (typeof src.space === "string" && src.space.trim()) out.space = src.space.trim();
  if (typeof src.principal_scope === "string" && src.principal_scope.trim()) out.principal_scope = src.principal_scope.trim();
  return Object.keys(out).length ? out : null;
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
  /** For type=task only: short title (the body carries the full description). null otherwise. */
  task_title: string | null;
  /** For type=task only: capabilities a claimant needs. [] = any capable reasoner. */
  requires: string[];
  /** For type=task only: optional role hint. null otherwise. */
  role: string | null;
  /** For type=task only: optional scope envelope (project/space/principal_scope). null otherwise. */
  scope: TaskScope | null;
  /** For type=task only: the task_id this one supersedes (forward work after a terminal close). null otherwise. */
  succeeds: string | null;
  /** For type=task only: how this task relates to the one it `succeeds`. Required iff `succeeds` is set. null otherwise. */
  succession: SuccessionRelation | null;
  /** For type=task only: optional raw start date (ISO-8601 / any Date-parseable string). Stored verbatim; null otherwise. */
  start_date: string | null;
  /** For type=task only: optional raw due date. `overdue`/`days_remaining` derive from it; null = no deadline (clear, not undetermined). */
  due_date: string | null;
  /** For type=task_state only: the truth transition. null otherwise. */
  task_status: TaskStatus | null;
  /** For type=task_condition only: the declared condition (pending|blocked). null otherwise. */
  condition: DeclarableCondition | null;
  /** For type=task_condition only: set (assert) or cleared (retract a prior assertion). null otherwise. */
  condition_state: ConditionState | null;
  /** For type=task_authorization only: the assignment assertion. null otherwise. */
  authorization: TaskAuthorization | null;
  /** For type=task_state / task_authorization: optional human-readable reason. null otherwise. */
  reason: string | null;
  /** For type=task_state: optional refs to the produced result (paths/event ids). [] otherwise. */
  result_refs: string[];
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
  /** For type=task: short title (body carries the description). */
  taskTitle?: string;
  /** For type=task: capabilities a claimant needs (`[]`/omitted = any capable reasoner). */
  requires?: string[];
  /** For type=task: optional role hint. */
  role?: string;
  /** For type=task: optional scope envelope. */
  scope?: TaskScope;
  /** For type=task: the task_id this task supersedes (forward work after a terminal close). Pair with `succession`. */
  succeeds?: string;
  /** For type=task: how this task relates to the one it `succeeds` (continuation|redo|correction). Required iff `succeeds` is set. */
  succession?: SuccessionRelation;
  /** For type=task: optional raw start date (any Date-parseable string), stored verbatim. */
  startDate?: string;
  /** For type=task: optional raw due date (any Date-parseable string). Drives derived `overdue`/`days_remaining`. */
  dueDate?: string;
  /** For type=task_state: the truth transition (completed|cancelled — both terminal/immutable). Required when type=task_state. */
  taskStatus?: TaskStatus;
  /** For type=task_condition with conditionState=set: the declared condition (pending|blocked). Required on a `set`. */
  condition?: DeclarableCondition;
  /** For type=task_condition: `set` (parent=task) asserts; `cleared` (parent=the set assertion) retracts it. Required. */
  conditionState?: ConditionState;
  /** For type=task_authorization: the assignment assertion (approved|revoked). Required when type=task_authorization. */
  authorization?: TaskAuthorization;
  /** For type=task_state / task_authorization / task_condition: optional human-readable reason (required on a condition `set`). */
  reason?: string;
  /** For type=task_state: optional refs to the produced result. */
  resultRefs?: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class EventLog {
  readonly root: string; // workspace root
  readonly dir: string; // events directory inside the workspace

  constructor(workspaceRoot: string) {
    this.root = path.resolve(workspaceRoot);
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

  /** The workspace root must already exist — we never silently create it. */
  private async assertRoot(): Promise<void> {
    try {
      const s = await fs.stat(this.root);
      if (!s.isDirectory()) throw new EventError(`Workspace path is not a folder: ${this.root}`, "WORKSPACE_NOT_DIR");
    } catch (e) {
      if (e instanceof EventError) throw e;
      throw new EventError(`Workspace folder does not exist: ${this.root}`, "WORKSPACE_MISSING");
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

    // Task-pool fields: only meaningful for the task event family. A task is born unassigned
    // (no owner here — ownership comes only from a later claim, §2.0). task_state/task_authorization
    // reference their task via parent_event_id (= the task's event_id).
    let task_title: string | null = null;
    let requires: string[] = [];
    let role: string | null = null;
    let scope: TaskScope | null = null;
    let succeeds: string | null = null;
    let succession: SuccessionRelation | null = null;
    let start_date: string | null = null;
    let due_date: string | null = null;
    let task_status: TaskStatus | null = null;
    let condition: DeclarableCondition | null = null;
    let condition_state: ConditionState | null = null;
    let authorization: TaskAuthorization | null = null;
    let reason: string | null = null;
    let result_refs: string[] = [];
    if (type === "task") {
      task_title =
        typeof opts.taskTitle === "string" && opts.taskTitle.trim() ? opts.taskTitle.trim() : firstLine(body) || null;
      requires = normalizeActors(opts.requires); // capability tokens: same trim/dedupe/order-stable shape
      role = typeof opts.role === "string" && opts.role.trim() ? opts.role.trim() : null;
      scope = normalizeScope(opts.scope);
      // Forward work after a terminal close: a successor references the original via succeeds + a typed
      // relation. The two travel together — a target with no relation (or vice versa) is meaningless.
      // Cross-task existence is a read-time/consumer concern; append stays single-event and append-only.
      const succeedsRaw = typeof opts.succeeds === "string" ? opts.succeeds.trim() : "";
      if (succeedsRaw || opts.succession !== undefined) {
        if (!succeedsRaw) {
          throw new EventError("a task with `succession` must also name the task it `succeeds`.", "BAD_SUCCESSION");
        }
        if (!opts.succession || !SUCCESSION_RELATIONS.includes(opts.succession)) {
          throw new EventError(
            `a successor task needs a succession relation (one of: ${SUCCESSION_RELATIONS.join(", ")}).`,
            "BAD_SUCCESSION"
          );
        }
        succeeds = succeedsRaw;
        succession = opts.succession;
      }
      // Raw temporal facts (sparse). Stored verbatim — derivation (overdue/days_remaining) happens at
      // read time, never baked as truth. Kept only when Date-parseable so a derived `overdue` is sound.
      const startRaw = typeof opts.startDate === "string" ? opts.startDate.trim() : "";
      if (startRaw && !Number.isNaN(Date.parse(startRaw))) start_date = startRaw;
      const dueRaw = typeof opts.dueDate === "string" ? opts.dueDate.trim() : "";
      if (dueRaw && !Number.isNaN(Date.parse(dueRaw))) due_date = dueRaw;
    } else if (type === "task_state") {
      if (!parentEventId) {
        throw new EventError("a task_state event must reference its task via parent_event_id.", "TASK_NO_PARENT");
      }
      if (!opts.taskStatus || !TASK_STATUSES.includes(opts.taskStatus)) {
        throw new EventError(`a task_state event needs task_status (one of: ${TASK_STATUSES.join(", ")}).`, "BAD_TASK_STATUS");
      }
      task_status = opts.taskStatus;
      reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
      result_refs = normalizeActors(opts.resultRefs);
    } else if (type === "task_authorization") {
      if (!parentEventId) {
        throw new EventError("a task_authorization event must reference its task via parent_event_id.", "TASK_NO_PARENT");
      }
      if (!opts.authorization || !TASK_AUTHORIZATIONS.includes(opts.authorization)) {
        throw new EventError(
          `a task_authorization event needs authorization (one of: ${TASK_AUTHORIZATIONS.join(", ")}).`,
          "BAD_AUTHORIZATION"
        );
      }
      authorization = opts.authorization;
      reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
    } else if (type === "task_condition") {
      // Declared condition assertion. `set` parents the TASK and asserts pending|blocked with a reason;
      // `cleared` parents the SET assertion it retracts (assertion identity = the set event's id), so
      // clearing one actor's blocker can't erase another's. Append-only; clearing is a new event, not a delete.
      if (!parentEventId) {
        throw new EventError("a task_condition event must reference its task (set) or the assertion it clears (cleared) via parent_event_id.", "TASK_NO_PARENT");
      }
      if (!opts.conditionState || !CONDITION_STATES.includes(opts.conditionState)) {
        throw new EventError(`a task_condition event needs condition_state (one of: ${CONDITION_STATES.join(", ")}).`, "BAD_CONDITION_STATE");
      }
      condition_state = opts.conditionState;
      reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
      if (condition_state === "set") {
        if (!opts.condition || !DECLARABLE_CONDITIONS.includes(opts.condition)) {
          throw new EventError(`a task_condition 'set' needs condition (one of: ${DECLARABLE_CONDITIONS.join(", ")}).`, "BAD_CONDITION");
        }
        if (!reason) {
          throw new EventError("a task_condition 'set' needs a non-empty reason (the reason carries the granularity).", "CONDITION_NO_REASON");
        }
        condition = opts.condition;
      }
    }

    await this.acquireLock(lock);
    try {
      const record: Record<string, unknown> = {
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
      // Task-family fields are written only on their own event types, so ordinary
      // message/ack/handoff lines stay lean (no forest of null task columns).
      if (type === "task") {
        record.task_title = task_title;
        record.requires = requires;
        record.role = role;
        record.scope = scope;
        // Only written when this task is a successor — ordinary tasks stay lean (no null lineage columns).
        if (succeeds) {
          record.succeeds = succeeds;
          record.succession = succession;
        }
        // Sparse temporal facts — written only when present, so dateless tasks stay lean.
        if (start_date) record.start_date = start_date;
        if (due_date) record.due_date = due_date;
      } else if (type === "task_state") {
        record.task_status = task_status;
        record.reason = reason;
        record.result_refs = result_refs;
      } else if (type === "task_authorization") {
        record.authorization = authorization;
        record.reason = reason;
      } else if (type === "task_condition") {
        if (condition) record.condition = condition; // present only on a `set`
        record.condition_state = condition_state;
        record.reason = reason;
      }
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
        task_title: type === "task" && typeof o.task_title === "string" ? o.task_title : null,
        requires: type === "task" ? normalizeActors(o.requires) : [],
        role: type === "task" && typeof o.role === "string" ? o.role : null,
        scope: type === "task" ? normalizeScope(o.scope) : null,
        succeeds: type === "task" && typeof o.succeeds === "string" && o.succeeds.trim() ? o.succeeds : null,
        succession:
          type === "task" && SUCCESSION_RELATIONS.includes(o.succession) ? (o.succession as SuccessionRelation) : null,
        start_date: type === "task" && typeof o.start_date === "string" && o.start_date.trim() ? o.start_date : null,
        due_date: type === "task" && typeof o.due_date === "string" && o.due_date.trim() ? o.due_date : null,
        // A legacy `reopened` value is no longer in TASK_STATUSES, so it parses to null here and is inert in
        // the fold (it can never un-close a terminal task) — the migration that makes old reopens harmless.
        task_status:
          type === "task_state" && TASK_STATUSES.includes(o.task_status) ? (o.task_status as TaskStatus) : null,
        condition:
          type === "task_condition" && DECLARABLE_CONDITIONS.includes(o.condition) ? (o.condition as DeclarableCondition) : null,
        condition_state:
          type === "task_condition" && CONDITION_STATES.includes(o.condition_state) ? (o.condition_state as ConditionState) : null,
        authorization:
          type === "task_authorization" && TASK_AUTHORIZATIONS.includes(o.authorization)
            ? (o.authorization as TaskAuthorization)
            : null,
        reason:
          (type === "task_state" || type === "task_authorization" || type === "task_condition") && typeof o.reason === "string"
            ? o.reason
            : null,
        result_refs: type === "task_state" ? normalizeActors(o.result_refs) : [],
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

    // First pass: read every thread ONCE and accumulate all events into a single GLOBAL causal index.
    // Owed-response discharge must follow the causal edge regardless of which thread carries the reply
    // (the GCL coordination spec: thread location must not hide or prevent causal response resolution). Event
    // refs are globally unique, so one cross-thread parent→child map is all it takes — zero schema change.
    const perThread: { t: string; events: AgentEvent[]; latest_seq: number }[] = [];
    const allEvents: AgentEvent[] = [];
    for (const t of names) {
      const { events, latest_seq } = await this.readRaw(t, 0);
      perThread.push({ t, events, latest_seq });
      allEvents.push(...events);
    }
    const globalChildren = indexChildren(allEvents); // cross-thread: keyed by globally-unique event_id

    const threads: ThreadOverview[] = [];
    const openForMe: OpenForMeItem[] = [];
    for (const { t, events, latest_seq } of perThread) {
      let myLast = 0;
      if (actor) for (const e of events) if (e.actor === actor) myLast = e.seq;
      const last = events.length ? events[events.length - 1] : null;
      const unread = latest_seq - myLast;

      // Ownership projection: fold the thread's claim events per work item (read-time expiry, no ledger
      // mutation). Claims reference their work item within the same thread, so this stays thread-local.
      const claimsByWorkItem = projectClaims(events, now);

      // Open responsibilities directed at this actor: addressed AND requires_response, not yet causally
      // answered by the actor — where "answered" now consults the GLOBAL index, so a reply in any thread
      // discharges the obligation. Structured addressed_to is canonical; a prose "@actor" mention in a
      // handoff is a labelled lower-confidence bridge for legacy/unstructured handoffs (source=heuristic).
      const threadOpen: OpenForMeItem[] = [];
      if (actor) {
        for (const e of events) {
          if (e.actor === actor) continue; // you don't owe yourself a response
          const addr = addresseesFor(e, actor, knownActors);
          if (!addr.matched || !e.requires_response) continue;
          if (actorRespondedCausally(globalChildren, e, actor)) continue; // cross-thread discharge

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

          // Coordination-integrity signal: this owed event's own parent is in another thread → the
          // discussion spans threads (the "right thread, wrong live discussion" split). Derived, cheap.
          const cross_thread = !!e.parent_event_id && threadOfRef(e.parent_event_id) !== t;

          threadOpen.push({
            thread: t,
            seq: e.seq,
            event_id: e.event_id,
            actor: e.actor,
            type: e.type,
            summary: firstLine(e.body),
            source: addr.source,
            ...(claim ? { claim } : {}),
            ...(cross_thread ? { cross_thread: true } : {}),
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
        // An open obligation always needs me. Otherwise: there is unread from someone else, but a
        // terminal event closes the loop — an ack (don't ping-pong on "you acked my ack"), a claim
        // (someone taking ownership isn't a ping for me), OR a latest event the actor has already
        // causally answered IN ANOTHER THREAD (cross-thread discharge must quiet the thread too, not
        // just clear open_for_me — else a resolved discussion keeps nagging from its old home).
        needs_me:
          threadOpen.length > 0 ||
          (!!last &&
            last.actor !== actor &&
            unread > 0 &&
            last.type !== "ack" &&
            last.type !== "claim" &&
            (!actor || !actorRespondedCausally(globalChildren, last, actor))),
        open_for_me: threadOpen.length,
      });
    }
    return { threads, open_for_me: openForMe, presence };
  }

  /**
   * Cross-thread causal responses to an owed event — the addresser-side "answered in …" projection
   * (the GCL coordination spec). Walks the GLOBAL causal DAG from `eventRef` across all threads and returns each
   * non-`claim` descendant response, flagging the ones that landed in a different thread so a connector can
   * render "answered in <thread>". A `claim` is excluded for the same reason discharge excludes it (taking
   * work ≠ answering). Optionally filter to one actor's responses. Pure read-time projection, zero mutation.
   */
  async causalResponses(eventRef: string, opts: { byActor?: string } = {}): Promise<CausalResponse[]> {
    await this.assertRoot();
    const allEvents: AgentEvent[] = [];
    for (const t of await this.listThreads()) {
      const { events } = await this.readRaw(t, 0);
      allEvents.push(...events);
    }
    const children = indexChildren(allEvents);
    const homeThread = threadOfRef(eventRef);
    const out: CausalResponse[] = [];
    const stack = [...(children.get(eventRef) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d.event_id)) continue;
      seen.add(d.event_id);
      if (d.type !== "claim" && (!opts.byActor || d.actor === opts.byActor)) {
        out.push({ event_id: d.event_id, thread: d.thread, actor: d.actor, type: d.type, cross_thread: d.thread !== homeThread });
      }
      const kids = children.get(d.event_id);
      if (kids) stack.push(...kids);
    }
    out.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
    return out;
  }

  /**
   * Project a SINGLE task's full state by id (truth, ownership, lineage, ignored terminal attempts).
   * Closed tasks leave the open pool but remain inspectable here — this is the read path that makes the
   * append-only invariant explainable: a later terminal attempt is ignored, not invisible (the GCL coordination spec).
   */
  async projectTask(thread: string, taskId: string, now: number = Date.now()): Promise<TaskProjection | null> {
    await this.assertRoot();
    const { events } = await this.readRaw(thread, 0);
    return projectTasks(events, now).get(taskId) ?? null;
  }

  /**
   * Capability-routed pool of unassigned open tasks across all threads (the GCL coordination spec–#244).
   * Visibility is unconditional; per-row `eligibility` reflects whether the active `policy`
   * lets THIS actor claim now. Live-claimed (assigned) tasks are excluded — they are
   * in-progress, not pool work; terminal tasks leave the pool but remain in history.
   * Returns the full structured rows + total count — the discoverability anchor: a caller
   * MUST NOT hide rows beyond this without surfacing the count and an expand path (AC n).
   */
  async taskPool(
    opts: TaskPoolOptions = {},
  ): Promise<{ open_pool: TaskRow[]; total_eligible: number; staleness_assessment: StalenessAssessment }> {
    await this.assertRoot();
    const now = opts.now ?? Date.now();
    const policy = opts.policy ?? DEFAULT_TASK_PULL_POLICY;
    const staleUnclaimedMs = opts.staleUnclaimedMs ?? DEFAULT_STALE_UNCLAIMED_MS;
    const staleVerificationMs = opts.staleVerificationMs ?? DEFAULT_STALE_VERIFICATION_MS;
    // No core default for the staleness cadence: absent a supplied policy, staleness is `undetermined`,
    // never auto-`stale` at a baked threshold (codex the GCL coordination spec). Connectors may pass a labeled one.
    const staleCadenceMs = opts.staleCadenceMs;
    const rows: TaskRow[] = [];
    for (const t of await this.listThreads()) {
      const { events } = await this.readRaw(t, 0);
      for (const p of projectTasks(events, now).values()) {
        if (p.truth !== "open") continue; // terminal → out of the active pool (history retains it)
        const c = p.creation;
        if (!scopeMatches(c.scope, opts.scope)) continue;
        if (!capabilitiesCover(c.requires, opts.capabilities)) continue; // not in MY pool (AC d)
        const liveOwner = !!p.ownership.owner && !p.ownership.stale;
        if (liveOwner) continue; // assigned/in-progress → not unassigned pool work

        // Stale hygiene — time-based reasons are deterministic here. Registry-based reasons
        // (no_capable_route / creator_unavailable) need a capability/route registry and are
        // populated by the caller (the connector), not core. Never auto-closes/hides (§2.6).
        const stale_reasons: StaleReason[] = [];
        const everClaimed = p.ownership.status !== null;
        if (!everClaimed && now - Date.parse(p.created_at) > staleUnclaimedMs) {
          stale_reasons.push("unclaimed_age_exceeded");
        }
        if (p.verification_pending && now - Date.parse(p.last_activity_at) > staleVerificationMs) {
          stale_reasons.push("verification_pending_age_exceeded");
        }

        // Derived condition FACTS (facts-vs-meaning): overdue + stale, each with an inspectable reason,
        // plus the raw temporal views they read from. Terminal tasks already left the pool, so every row
        // here is open — the only lifecycle state on which conditions are meaningful.
        const days_since_activity = Math.max(0, Math.floor((now - Date.parse(p.last_activity_at)) / DAY_MS));
        const dueMs = c.due_date ? Date.parse(c.due_date) : NaN;
        const days_remaining = Number.isNaN(dueMs) ? null : Math.floor((dueMs - now) / DAY_MS);
        const conditions: ConditionFlag[] = [
          // Derived facts (overdue/stale) ...
          ...deriveConditions({
            now,
            due_date: c.due_date,
            dueMs,
            days_remaining,
            last_activity_at: p.last_activity_at,
            days_since_activity,
            staleCadenceMs,
          }),
          // ... plus author-DECLARED conditions (pending/blocked), each carrying its assertion's reason.
          ...p.declared_conditions.map((d) => ({ condition: d.condition, reason: d.reason })),
        ];

        rows.push({
          task_id: p.task_id,
          thread: p.thread,
          title: c.task_title ?? firstLine(c.body),
          requires: c.requires,
          role: c.role,
          scope: c.scope,
          succeeds: c.succeeds,
          succession: c.succession,
          truth: p.truth,
          verification_pending: p.verification_pending,
          authorized: p.authorized,
          eligibility: eligibilityUnderPolicy(p, policy),
          stale_reasons,
          conditions,
          start_date: c.start_date,
          due_date: c.due_date,
          days_remaining,
          days_since_activity,
          addressed_to: c.addressed_to,
          created_at: p.created_at,
          last_activity_at: p.last_activity_at,
          age_seconds: Math.max(0, Math.floor((now - Date.parse(p.created_at)) / 1000)),
        });
      }
    }
    // Advisory default order (codex #243): authorized first → claimable-now → oldest first.
    // A default sort only; grouping/threshold/relevance stay the client's view choice.
    rows.sort((a, b) => {
      if (a.authorized !== b.authorized) return a.authorized ? -1 : 1;
      if (a.eligibility !== b.eligibility) return a.eligibility === "claimable_now" ? -1 : 1;
      return b.age_seconds - a.age_seconds;
    });
    // Staleness coverage at the aggregate boundary: assessed against a supplied cadence, otherwise
    // `undetermined` ONCE for the whole pool — never decorated per row (codex the GCL coordination spec).
    const staleness_assessment: StalenessAssessment =
      staleCadenceMs === undefined
        ? { status: "undetermined", reason: "no_cadence_policy" }
        : { status: "assessed", cadence_ms: staleCadenceMs };
    return { open_pool: rows, total_eligible: rows.length, staleness_assessment };
  }
}

/** The thread portion of an event ref `thread#seq` (event_ids/parent refs are globally unique). */
function threadOfRef(ref: string): string {
  const i = ref.lastIndexOf("#");
  return i > 0 ? ref.slice(0, i) : ref;
}

/**
 * Build a parent_event_id → children map for causal descent. Keys are globally-unique event refs
 * (`thread#seq`), so passing events from MULTIPLE threads yields a cross-thread causal index — which is
 * how an owed response is discharged by a causal reply that landed in another thread (the GCL coordination spec).
 */
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

// ── Capability-routed task pool projection (the GCL coordination spec–#244) ───────────────────────────────────
// A task is an event-sourced aggregate: creation (`type: task`, task_id := event_id) + lifecycle
// events folded at read time. TRUTH (task_state) is folded SEPARATELY from OWNERSHIP (claim) — the
// ratified line (§2.3): claim(completed) closes ownership only, never task truth.

export type TaskTruth = "open" | "completed" | "cancelled";

/** Why a still-open task is flagged for human attention. Derived only — never an event/terminal state (§2.6). */
export type StaleReason =
  | "unclaimed_age_exceeded"
  | "verification_pending_age_exceeded"
  | "no_capable_route" // requires registry knowledge — populated by the caller, not core
  | "creator_unavailable"; // requires route knowledge — populated by the caller, not core

/** Whether the orienting actor may claim a pool task right now, under the active policy. */
export type TaskEligibility = "claimable_now" | "needs_authorization";

/**
 * A terminal `task_state` event that arrived AFTER the task's truth was already settled — ignored by
 * first-terminal-wins, but never invisible: retained here with provenance so a connector can explain the
 * conflict ("X tried to mark this cancelled, but it was already completed"). The first terminal stays
 * authoritative; these supersede nothing (the GCL coordination spec, codex's naming).
 */
export interface TerminalAttempt {
  event_id: string;
  actor: string;
  attempted_status: TaskStatus;
  at: string;
  reason: "already_terminal";
  /** The winning terminal event that had already settled the truth — the provenance edge that makes the
   * conflict self-explaining ("ignored because settled_by_event_id closed it first"). Part of the
   * explanation contract, not cosmetic (codex the GCL coordination spec). */
  settled_by_event_id: string;
}

export interface TaskProjection {
  task_id: string;
  thread: string;
  creation: AgentEvent;
  truth: TaskTruth;
  /** Ownership was `completed` but truth never closed → work done, acceptance pending (§2.3). */
  verification_pending: boolean;
  ownership: ClaimState;
  /** Latest task_authorization: approved (and not later revoked). */
  authorized: boolean;
  /** Later terminal task_state events ignored by first-terminal-wins — retained, never silently dropped. */
  ignored_terminal_attempts: TerminalAttempt[];
  /** ACTIVE declared conditions (pending/blocked `set` and not yet `cleared`), each with its own author + reason. */
  declared_conditions: DeclaredCondition[];
  created_at: string;
  last_activity_at: string;
}

function pushInto(m: Map<string, AgentEvent[]>, k: string, v: AgentEvent): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/**
 * Fold one thread's events into per-task projections. Truth (task_state) and ownership (claim) are
 * folded independently; authorization is the latest approved/revoked. Pure read-time projection.
 */
function projectTasks(events: AgentEvent[], now: number): Map<string, TaskProjection> {
  const claims = projectClaims(events, now);
  const stateByTask = new Map<string, AgentEvent[]>();
  const authByTask = new Map<string, AgentEvent[]>();
  const claimByTask = new Map<string, AgentEvent[]>();
  // Declared conditions: a `set` parents the task; a `cleared` parents the SET assertion it retracts
  // (assertion identity = the set event's id), so one actor's clear can't erase another's blocker.
  const conditionSetsByTask = new Map<string, AgentEvent[]>();
  const conditionSetById = new Map<string, AgentEvent>(); // set event_id → the set, for clear validation
  const clearEvents: AgentEvent[] = [];
  for (const e of events) {
    if (!e.parent_event_id) continue;
    if (e.type === "task_state") pushInto(stateByTask, e.parent_event_id, e);
    else if (e.type === "task_authorization") pushInto(authByTask, e.parent_event_id, e);
    else if (e.type === "claim") pushInto(claimByTask, e.parent_event_id, e);
    else if (e.type === "task_condition") {
      if (e.condition_state === "set") {
        pushInto(conditionSetsByTask, e.parent_event_id, e);
        conditionSetById.set(e.event_id, e);
      } else if (e.condition_state === "cleared") {
        clearEvents.push(e);
      }
    }
  }
  // A `cleared` retracts its parent ONLY when that parent is a real `task_condition:set` assertion.
  // The projection resolves the parent and IGNORES a clear that points anywhere else (the task itself, a
  // message, a foreign event) — you cannot retract a blocker that was never asserted. Because a clear names
  // the exact set by id, "same task/condition" is intrinsic once the parent resolves to a set (codex
  // the GCL coordination spec). Collected after the full pass so a clear preceding its set in scan order still
  // validates against the complete set index.
  const clearedAssertionIds = new Set<string>();
  for (const c of clearEvents) {
    const parent = c.parent_event_id; // non-null: the scan loop skipped parentless events
    if (parent && conditionSetById.has(parent)) clearedAssertionIds.add(parent);
  }

  const out = new Map<string, TaskProjection>();
  for (const e of events) {
    if (e.type !== "task") continue;
    const taskId = e.event_id;
    let truth: TaskTruth = "open";
    let settledByEventId: string | null = null; // the FIRST terminal event that settled truth — provenance
    let lastAt = e.created_at;
    const ignored_terminal_attempts: TerminalAttempt[] = [];
    for (const s of stateByTask.get(taskId) ?? []) {
      if (s.created_at > lastAt) lastAt = s.created_at;
      // Terminal states are IMMUTABLE: the FIRST completed/cancelled settles the truth, and any later
      // task_state event is ignored (it cannot un-close or flip a settled task — reopening is tampering).
      // A later event still advances last_activity_at above, so the history stays visible.
      if (truth !== "open") {
        // Retain the ignored attempt with provenance — never silently invisible (codex the GCL coordination spec),
        // and point it at the winning terminal so the conflict is self-explaining (codex the GCL coordination spec).
        if (s.task_status === "completed" || s.task_status === "cancelled") {
          ignored_terminal_attempts.push({
            event_id: s.event_id,
            actor: s.actor,
            attempted_status: s.task_status,
            at: s.created_at,
            reason: "already_terminal",
            settled_by_event_id: settledByEventId!,
          });
        }
        continue;
      }
      if (s.task_status === "completed") {
        truth = "completed";
        settledByEventId = s.event_id;
      } else if (s.task_status === "cancelled") {
        truth = "cancelled";
        settledByEventId = s.event_id;
      }
    }
    let authorized = false;
    for (const a of authByTask.get(taskId) ?? []) {
      if (a.created_at > lastAt) lastAt = a.created_at;
      if (a.authorization === "approved") authorized = true;
      else if (a.authorization === "revoked") authorized = false;
    }
    for (const c of claimByTask.get(taskId) ?? []) if (c.created_at > lastAt) lastAt = c.created_at;

    // Active declared conditions = `set` assertions on this task not retracted by a later `cleared`.
    const declared_conditions: DeclaredCondition[] = [];
    for (const s of conditionSetsByTask.get(taskId) ?? []) {
      if (s.created_at > lastAt) lastAt = s.created_at;
      if (clearedAssertionIds.has(s.event_id) || !s.condition) continue;
      declared_conditions.push({
        assertion_id: s.event_id,
        condition: s.condition,
        reason: s.reason ?? "",
        actor: s.actor,
        since: s.created_at,
      });
    }

    const ownership = claims.get(taskId) ?? { owner: null, expires: null, stale: false, status: null };
    // verification_pending: the owner closed their CLAIM as completed, but no task_state(completed)
    // closed the task's truth. The task is still open / pending acceptance — not done.
    const verification_pending = truth === "open" && ownership.status === "completed";

    out.set(taskId, {
      task_id: taskId,
      thread: e.thread,
      creation: e,
      truth,
      verification_pending,
      ownership,
      authorized,
      ignored_terminal_attempts,
      declared_conditions,
      created_at: e.created_at,
      last_activity_at: lastAt,
    });
  }
  return out;
}

/** One structured `open_pool` row (codex #243). Grouping/sorting is the client's view choice. */
export interface TaskRow {
  task_id: string;
  thread: string;
  title: string;
  requires: string[];
  role: string | null;
  scope: TaskScope | null;
  /** Lineage: the task_id this one supersedes (forward work after a terminal close), or null. */
  succeeds: string | null;
  /** Lineage: how this task relates to the one it `succeeds` (continuation|redo|correction), or null. */
  succession: SuccessionRelation | null;
  truth: TaskTruth;
  verification_pending: boolean;
  authorized: boolean;
  /** Eligibility UNDER THE ACTIVE POLICY — visibility is unconditional, claimability is gated. */
  eligibility: TaskEligibility;
  /** Hygiene flags (§2.6); presence never changes claimability or hides the row. */
  stale_reasons: StaleReason[];
  /** Derived condition FACTS (overdue/stale, each with a reason); facts-vs-meaning — shown, never blended into a score. */
  conditions: ConditionFlag[];
  /** Raw temporal facts (sparse). null = no such date recorded. */
  start_date: string | null;
  due_date: string | null;
  /** Computed view of `due_date` vs now in whole days (negative = past due); null when no due_date. */
  days_remaining: number | null;
  /** Computed view: whole days since the last qualifying activity. */
  days_since_activity: number;
  /** Routing metadata only — never ownership (codex #242). */
  addressed_to: string[];
  created_at: string;
  last_activity_at: string;
  age_seconds: number;
}

/**
 * Pool-wide staleness COVERAGE — reported once at the aggregate boundary, not per row (codex
 * the GCL coordination spec). `undetermined` here means the pool was assessed for staleness but no cadence policy
 * was supplied, so the dimension is honestly unknown for every open task — a "set a cadence" hygiene signal
 * that keeps the corpus from turning yellow row-by-row. `assessed` means a policy was in force.
 */
export interface StalenessAssessment {
  status: "assessed" | "undetermined";
  /** Present when `undetermined`: the machine reason a connector can label. */
  reason?: "no_cadence_policy";
  /** Present when `assessed`: the cadence window applied. */
  cadence_ms?: number;
}

export interface TaskPoolOptions {
  /** The orienting actor (for mine/eligibility framing). */
  actor?: string;
  /** The actor's capabilities; when given, only tasks whose `requires ⊆ capabilities` are in MY pool (AC d). */
  capabilities?: string[];
  /** Active pull policy. Default `human_directed` (unassigned-by-default). */
  policy?: TaskPullPolicy;
  /** Filter to a scope (project/space). principal_scope never gates in v0 (AC e). */
  scope?: TaskScope;
  /** Read clock; defaults to now. */
  now?: number;
  /** Age after which an unclaimed open task is flagged `unclaimed_age_exceeded`. */
  staleUnclaimedMs?: number;
  /** Age after which a verification_pending task is flagged `verification_pending_age_exceeded`. */
  staleVerificationMs?: number;
  /** Cadence window after which an open task with no qualifying activity derives the `stale` condition. */
  staleCadenceMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_UNCLAIMED_MS = 3 * DAY_MS; // 3 days — config, not a constant
const DEFAULT_STALE_VERIFICATION_MS = 1 * DAY_MS; // 1 day — config, not a constant
// NB: there is deliberately NO default stale CADENCE — staleness without a policy is `undetermined`, not a
// baked 7d `stale`. Any 7d default belongs to a connector as a labeled display policy (codex the GCL coordination spec).

/**
 * Derive an open task's condition FACTS from raw temporal data — facts only, never opinions (no "soon",
 * no risk, no ranking). Conditions stack; each carries an inspectable reason. v0 emits only the two
 * purely-derived facts; `pending`/`blocked` are author-declared (mechanism TBD) and `undetermined` is the
 * honest fallback for a determination that was expected but can't be made (none auto-fires for tasks yet).
 */
function deriveConditions(input: {
  now: number;
  due_date: string | null;
  dueMs: number;
  days_remaining: number | null;
  last_activity_at: string;
  days_since_activity: number;
  /** Cadence policy in ms. UNDEFINED = no policy → staleness is `undetermined`, never a baked default. */
  staleCadenceMs?: number;
  /** Opt-in: when no cadence policy exists, surface `undetermined` AS A PER-ROW CONDITION. Default off —
   * the base projection must NOT decorate every row yellow just because no policy is set; that coverage gap
   * lives at the aggregate boundary (`staleness_assessment`). Only an explicit assessment/expand context
   * that asked about THIS row's staleness sets this true (codex the GCL coordination spec). */
  emitUndeterminedPerRow?: boolean;
}): ConditionFlag[] {
  const out: ConditionFlag[] = [];
  // overdue — zero-threshold derived fact: now is past a real due_date.
  if (input.due_date && !Number.isNaN(input.dueMs) && input.now > input.dueMs) {
    const daysPast = input.days_remaining === null ? 0 : Math.abs(input.days_remaining);
    out.push({ condition: "overdue", reason: `due ${input.due_date}; ${daysPast}d past` });
  }
  // staleness is assessable ONLY against a cadence policy. Absent one, the dimension is `undetermined`
  // (honest "unassessed" — not a silent fresh, not a baked `stale after 7d`). A 7d default is a CONNECTOR
  // display policy, never a GCL fact (codex the GCL coordination spec). With a policy: stale-or-clear by activity.
  // The no-policy case is dimension-relative coverage, not a property of the work — so it is reported ONCE at
  // the aggregate boundary, not stamped on every row, unless an assessment context opts in per-row (#23).
  if (input.staleCadenceMs === undefined) {
    if (input.emitUndeterminedPerRow) {
      out.push({ condition: "undetermined", reason: "staleness unassessed — no cadence policy set" });
    }
  } else if (input.now - Date.parse(input.last_activity_at) > input.staleCadenceMs) {
    const cadenceDays = Math.round(input.staleCadenceMs / DAY_MS);
    out.push({ condition: "stale", reason: `no activity for ${input.days_since_activity}d (cadence ${cadenceDays}d)` });
  }
  return out;
}

function scopeMatches(taskScope: TaskScope | null, filter: TaskScope | undefined): boolean {
  if (!filter) return true;
  if (filter.project && taskScope?.project !== filter.project) return false;
  if (filter.space && taskScope?.space !== filter.space) return false;
  return true; // principal_scope is opaque metadata; never gates visibility in v0 (AC e)
}
function capabilitiesCover(requires: string[], caps: string[] | undefined): boolean {
  if (caps === undefined) return true; // no capability filter supplied → show all
  return requires.every((r) => caps.includes(r));
}
function eligibilityUnderPolicy(p: TaskProjection, policy: TaskPullPolicy): TaskEligibility {
  const staleClaim = !!p.ownership.owner && p.ownership.stale;
  switch (policy) {
    case "proactive":
      return "claimable_now"; // fresh or stale; stale would be stamped stale_at_claim by the claimer
    case "proactive_until_stale":
      return staleClaim ? (p.authorized ? "claimable_now" : "needs_authorization") : "claimable_now";
    case "human_directed":
    default:
      return p.authorized ? "claimable_now" : "needs_authorization"; // unassigned-by-default
  }
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
  /**
   * True when this owed event's own causal parent lives in ANOTHER thread — the discussion it belongs to
   * spans threads. A coordination-integrity signal (not stale): it flags the "right thread name, wrong live
   * discussion" split so a connector can surface "continued in …". Derived, never authored.
   */
  cross_thread?: boolean;
}

/** A causal response to an owed event, possibly in a different thread (the addresser-side "answered in …" view). */
export interface CausalResponse {
  event_id: string;
  thread: string;
  actor: string;
  type: EventType;
  /** True when the response landed in a different thread than the event it answers. */
  cross_thread: boolean;
}

function firstLine(s: string): string {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}
