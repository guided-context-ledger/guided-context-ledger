import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGuidance, parseActors, type GuidanceInput } from "../src/guidance.js";

// Base: a genesis workspace, no profile for the orienting agent, empty roster, nothing open.
const base: GuidanceInput = {
  actor: "claude-cli",
  head: "rev_genesis",
  profilePresent: false,
  profilePath: "agents/claude-cli/profile.md",
  actors: [],
  needsMeCount: 0,
  openForMeCount: 0,
  unreadThreadCount: 0,
};

const actions = (i: Partial<GuidanceInput>) =>
  computeGuidance({ ...base, ...i }).suggested_actions.map((a) => a.action);

test("genesis + no profile + no human → create_profile + first_commit + set_principal", () => {
  const g = computeGuidance(base);
  assert.equal(g.workspace_state, "genesis");
  assert.deepEqual(g.suggested_actions.map((a) => a.action), [
    "create_profile",
    "first_commit_when_ready",
    "set_principal",
  ]);
});

test("provisioning (revisions, no profile, unregistered, no human) → create_profile + register + set_principal", () => {
  assert.deepEqual(
    actions({ head: "rev_abc", actors: [{ id: "codex", kind: "agent" }] }),
    ["create_profile", "register_in_manifest", "set_principal"],
  );
});

test("ready + idle + registered + human present → single nothing_pending", () => {
  const g = computeGuidance({
    ...base,
    head: "rev_abc",
    profilePresent: true,
    actors: [
      { id: "claude-cli", kind: "agent" },
      { id: "kyle", kind: "human", role: "owner" },
    ],
  });
  assert.equal(g.workspace_state, "ready");
  assert.deepEqual(g.suggested_actions.map((a) => a.action), ["nothing_pending"]);
});

test("ready, registered agent, but no human → set_principal (not nothing_pending)", () => {
  assert.deepEqual(
    actions({ head: "rev_abc", profilePresent: true, actors: [{ id: "claude-cli", kind: "agent" }] }),
    ["set_principal"],
  );
});

test("ready + open work → no nothing_pending (existing fields carry the work)", () => {
  assert.deepEqual(
    actions({
      head: "rev_abc",
      profilePresent: true,
      actors: [{ id: "claude-cli", kind: "agent" }, { id: "kyle", kind: "human" }],
      openForMeCount: 2,
    }),
    [],
  );
});

test("manifest unreadable (null roster) → register + set_principal skipped (graceful)", () => {
  assert.deepEqual(
    actions({ head: "rev_abc", profilePresent: true, actors: null }),
    ["nothing_pending"],
  );
});

test("bare model/family id → use_interface_actor_id advisory leads", () => {
  const acts = actions({ actor: "claude", actors: [{ id: "kyle", kind: "human" }] });
  assert.equal(acts[0], "use_interface_actor_id");
});

test("create_profile reason points at the agent-profile template + names the convention", () => {
  const create = computeGuidance(base).suggested_actions.find((a) => a.action === "create_profile");
  assert.ok(create);
  assert.match(create.reason, /agent-profile\.template\.md/);
  assert.match(create.reason, /not your model or family name/);
});

test("parseActors: inline empty, inline ids, block objects, and null", () => {
  assert.equal(parseActors(null), null);
  assert.deepEqual(parseActors("---\nactors: []\n---\n"), []);
  assert.deepEqual(parseActors("---\nactors: [a, b]\n---\n"), [{ id: "a" }, { id: "b" }]);
  const block =
    "---\n" +
    "actors:\n" +
    "  - id: kyle\n" +
    "    kind: human\n" +
    "    role: owner\n" +
    "    profile: people/kyle/profile.md\n" +
    "  - id: claude-desktop\n" +
    "    kind: agent\n" +
    "shared_files: []\n" +
    "---\n";
  assert.deepEqual(parseActors(block), [
    { id: "kyle", kind: "human", role: "owner", profile: "people/kyle/profile.md" },
    { id: "claude-desktop", kind: "agent" },
  ]);
  assert.deepEqual(parseActors("no frontmatter"), []);
});
