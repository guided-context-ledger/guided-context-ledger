// First-run guidance: an additive, derived projection over state orient already reads.
// Pure and side-effect-free so it can be unit-tested directly and never persists anything.
// It turns a descriptive orient ("here is the state") into a prescriptive one ("here is what to do next"),
// which is the first-run UX gap the cold-boot smoke surfaced.

export type WorkspaceState = "genesis" | "provisioning" | "ready";
export type ActorKind = "human" | "agent";

/** One entry in the manifest's unified actor registry (people + agents in one list). */
export interface ActorEntry {
  id: string;
  kind?: ActorKind;
  role?: string;
  profile?: string;
}

export interface SuggestedAction {
  /** Stable machine-readable verb the client can branch on. */
  action:
    | "use_interface_actor_id"
    | "create_profile"
    | "first_commit_when_ready"
    | "register_in_manifest"
    | "set_principal"
    | "nothing_pending";
  /** Human-readable why, safe to surface verbatim. */
  reason: string;
  /** Doc anchor for the step, or null when none applies. */
  ref: string | null;
}

export interface Guidance {
  workspace_state: WorkspaceState;
  suggested_actions: SuggestedAction[];
}

export interface GuidanceInput {
  /** Per-interface actor id orient was called with. */
  actor: string;
  /** Ledger HEAD ("rev_genesis" when no revisions exist yet). */
  head: string;
  /** Whether the orienting actor's own profile (agents/<id>/profile.md, or legacy) resolved. */
  profilePresent: boolean;
  /** Default/resolved profile path for this actor, surfaced in the create_profile reason. */
  profilePath: string;
  /** The manifest's actors[] roster, or null when the manifest is absent/unreadable (graceful degradation). */
  actors: ActorEntry[] | null;
  needsMeCount: number;
  openForMeCount: number;
  /** Threads with unread events since this actor last posted. */
  unreadThreadCount: number;
}

const FIRST_RUN_REF = "README#first-run";

// A bare model/family name with no interface suffix collapses identity across interfaces of the same
// model. Detection, not enforcement — orient nudges toward a per-interface id but never blocks.
const BARE_FAMILY = /^(claude|gpt|chatgpt|openai|gemini|bard|grok|llama|mistral|copilot|deepseek)$/i;

/**
 * Parse the unified `actors[]` registry from a manifest's YAML frontmatter. Handles inline empty
 * (`actors: []`) and the canonical block-of-objects form. Returns null when the manifest is absent so
 * the caller can skip roster-dependent suggestions rather than assert "unregistered" on missing data.
 * The connector's scalar-only frontmatter parser cannot read nested objects; this can.
 */
export function parseActors(manifestMd: string | null): ActorEntry[] | null {
  if (manifestMd === null) return null;
  const fm = manifestMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const lines = fm[1].split("\n");
  const start = lines.findIndex((l) => /^actors:/.test(l));
  if (start === -1) return [];
  const inline = lines[start].replace(/^actors:\s*/, "").trim();
  if (inline.startsWith("[")) {
    // Inline `[a, b]` — ids only; richer fields require the block form.
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.replace(/['"]/g, "").trim())
      .filter(Boolean)
      .map((id) => ({ id }));
  }
  const out: ActorEntry[] = [];
  let cur: ActorEntry | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // dedented to the next top-level key — registry block ended
    const item = line.match(/^\s*-\s*(?:id:\s*)?(.+?)\s*$/);
    const field = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (item && /^\s*-/.test(line)) {
      if (cur) out.push(cur);
      const v = item[1].replace(/^id:\s*/, "").replace(/['"]/g, "").trim();
      cur = { id: v };
    } else if (field && cur) {
      const key = field[1];
      const val = field[2].replace(/['"]/g, "").trim();
      if (key === "kind") cur.kind = val === "human" ? "human" : "agent";
      else if (key === "role") cur.role = val;
      else if (key === "profile") cur.profile = val;
      else if (key === "id") cur.id = val;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Derive first-run guidance from already-read orient state. Ordering reflects the first-run sequence:
 * fix a bad id, create your profile, checkpoint, register, capture the human principal. `nothing_pending`
 * is the affirmative for a fully set-up, idle actor so "ready + nothing open" reads as a deliberate
 * all-clear, not silence.
 */
export function computeGuidance(input: GuidanceInput): Guidance {
  const { actor, head, profilePresent, profilePath, actors, needsMeCount, openForMeCount, unreadThreadCount } = input;
  const isGenesis = head === "rev_genesis";

  const workspace_state: WorkspaceState = profilePresent ? "ready" : isGenesis ? "genesis" : "provisioning";

  const a: SuggestedAction[] = [];

  if (BARE_FAMILY.test(actor)) {
    a.push({
      action: "use_interface_actor_id",
      reason:
        `"${actor}" looks like a model/family name. Use a per-interface coordination id ` +
        `(e.g. "${actor}-desktop", "${actor}-cli") so your identity and presence don't collapse with ` +
        `other interfaces of the same model.`,
      ref: FIRST_RUN_REF,
    });
  }

  if (!profilePresent) {
    a.push({
      action: "create_profile",
      reason:
        `No actor profile for you in this workspace. Copy templates/agent-profile.template.md to ${profilePath}. ` +
        `Use your per-interface actor id (e.g. "claude-cowork") — not your model or family name.`,
      ref: FIRST_RUN_REF,
    });
  }

  if (isGenesis) {
    a.push({
      action: "first_commit_when_ready",
      reason:
        "The ledger is at genesis (no revisions). After setup, gcl_commit a checkpoint so the next cold " +
        "reader reconstructs from real committed state, not an empty scaffold.",
      ref: FIRST_RUN_REF,
    });
  }

  // Register only once there is a populated workspace to join (not at pure genesis, where first_commit
  // is the priority) and only when we could read the roster and this actor is absent from it.
  const registered = actors?.some((e) => e.id === actor) ?? false;
  if (!isGenesis && actors !== null && !registered) {
    a.push({
      action: "register_in_manifest",
      reason: `Add "${actor}" to actors[] in workspace.manifest.md so peers can discover you.`,
      ref: FIRST_RUN_REF,
    });
  }

  // Multi-user enabler: capture the human principal if none is registered. Single-user = one human owner;
  // multi-user falls out by repeating this per person.
  const hasHuman = actors?.some((e) => e.kind === "human") ?? false;
  if (actors !== null && !hasHuman) {
    a.push({
      action: "set_principal",
      reason:
        "No human principal is registered. Capture the person you act for: create people/<id>/profile.md and " +
        "add them to actors[] as { kind: human, role: owner }. Multi-user = each person repeats this.",
      ref: FIRST_RUN_REF,
    });
  }

  if (
    a.length === 0 &&
    profilePresent &&
    !isGenesis &&
    needsMeCount === 0 &&
    openForMeCount === 0 &&
    unreadThreadCount === 0
  ) {
    a.push({
      action: "nothing_pending",
      reason: "You're oriented and nothing needs you right now.",
      ref: null,
    });
  }

  return { workspace_state, suggested_actions: a };
}
