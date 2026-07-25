---
gcl_version: 0.1.0
file_type: spec
title: Task Lifecycle
status: active
written_by: claude-cowork
written_at: 2026-06-30
last_updated: 2026-06-30
authoritative: true
ratified_by: [codex]
ratified_at: 2026-06-30
tags: [task-lifecycle, closure, assumption-gate, complexity, verification, outcome]
---

# Task Lifecycle

> **Status: Active — ratified.** The §6 `task_verification` lane was the ratification condition and is folded in. Build-feasibility (where the closure gate + verification projection land in the handler) is a build-track confirmation, not a spec blocker. Frames off the active `spec/Authority-and-Hierarchy.md` and `spec/Identity-and-Attestation.md`. Defines the STRUCTURE + rules; machine-enforcement of the closure gate rides the identity build track and is advisory until then — projection-first enforcement makes the gap visible immediately (§6).

## 1. The problem
GCL has no formal distinction between **work complete**, **contract complete**, and **outcome complete**. Agents close tasks at work-complete and report them as outcome-complete. This is a *protocol* gap, not a discipline gap — the protocol currently lets any actor declare done unilaterally (`task_state: completed` from anyone). A recurring real-world failure: the team reports completion; the desired outcome isn't there.

**Mental model (locked): manufacturing QC.** All lane work can be done, but a final inspector checks the *assembled product* against the *original goal* before it ships — not the individual components.

## 2. Three completion states
- **Work complete** — the executing actor finished its lane.
- **Contract complete** — the deliverable matches what was asked for (verified by someone other than the executor).
- **Outcome complete** — the system behaves as intended end-to-end against the original goal.

Closure must name which of these it asserts. "Done" alone is banned.

## 3. The lifecycle

### 3.1 Creation — set by the authorized human, never the executor
At task creation the authorized human sets three things the executing agent **cannot self-assign**:
- **`outcome_statement`** — what success actually means.
- **`complexity_class`** — from the complexity gate (§3.3).
- **`closure_type`** — auto-closeable / peer-reviewed / human-gated (§4).

Agents may *propose* these for human approval; agent-defined criteria without human sign-off is the same problem with extra steps.

### 3.2 Assumption-declaration gate
Before work begins on a qualifying task, the actor **declares its interpretation of the desired outcome** in plain terms. The authorized human confirms/corrects/refines. The confirmed interpretation locks into the task record as **`outcome_assumption`** — the baseline against which work, verification, and closure are evaluated. (Binds to the existing `assumptions` commit field.)

### 3.3 Complexity gate — two paths
- **Path 1 — irreversibility HARD gate.** If the action is irreversible or hard to reverse, the assumption declaration + human confirmation are mandatory **regardless** of apparent simplicity. No scoring, no exceptions.
- **Path 2 — reversible scoring.** Score three dimensions (criteria defined by protocol, not the agent): **scope** (touches >1 file/spec/system?), **ambiguity** (>1 reasonable interpretation?), **dependencies** (does anything depend on this outcome?). Above threshold ⇒ declaration required; below ⇒ proceed (closure type still applies). *(Exact thresholds: OPEN — owner-set.)*

### 3.4 Mid-task assumption revision
If work reveals the original assumption was wrong mid-task, there must be a protocol path to surface it: a **mid-task assumption-revision event**, distinct from the initial declaration — so the agent neither silently continues on a wrong baseline nor abandons with no record of what was learned.

### 3.5 Closure (§4).

## 4. Closure types
- **Auto-closeable** — criteria mechanical + deterministic (test passes, schema validates, file exists). Verified by a **DIFFERENT actor than the executor**. No human required.
- **Peer-reviewed** — executor completes; a **separate** eligible agent with the required capability/grant independently verifies. No human gate.
- **Human-gated** — executor completes, a separate agent verifies, **then** the authorized human approves via a **human-authorization token** (§5). For intent, feel, or system-level/outcome correctness beyond mechanical checks.

Common rule across all three: **the verifier is never the executor.**

## 5. The human-authorization token & delegation
- The **human-authorization token** is a `GclSessionToken` (`spec/Identity-and-Attestation.md`) carrying a **verified human `principal`** at tier ≥ `principal_attested`, holding the required Approve grant.
- **Delegation composes with the hierarchy — not a special case.** An owner designating someone as approver is an **Approve grant** (`spec/Authority-and-Hierarchy.md`) scoped to that task/project. The designee's human-auth token then satisfies the gate within that scope; revoking is a ledger event. The closure verifier is valid only if the session principal holds the required grant **at verification time**.

## 6. Schema mapping (schema-ratified)
Integration with the existing task model (`@guided-context-ledger/core` events: `task` aggregate / `claim` ownership / `task_authorization` = claim-eligibility / `task_state` = terminal truth / `task_condition` = pending/blocked):

1. **Creation-time fields on the `task` event** (set by the authorized human/principal):
   - `closure_type`: `auto_closeable | peer_reviewed | human_gated`
   - `complexity_class`: `simple | scored | irreversible`
   - `outcome_assumption`: structured — `{statement, confirmed_by_principal, confirmed_at, assumption_ref?}`
   - optional `verification_requires` (peer capability/grant needs), only when used.
2. **`task_authorization` is NOT reused for closure** — it stays claim/start eligibility. Overloading it would re-collapse "may start work" with "outcome accepted" — exactly the bug this spec fixes.
3. **NEW event lane: `task_verification`** (parents the task): `{verification_status: verified | rejected, closure_type, basis/reason, result_refs, target_task_state_event_id?, + provenance axes (actor/principal/mediated_by)}`.
   - `human_gated` → verifier is a verified human principal, tier ≥ `principal_attested`, holding the required Approve grant.
   - `auto_closeable` → verifier ≠ executor/claimer **and** mechanical criteria met.
   - `peer_reviewed` → verifier is a different eligible actor with the required capability/grant.
4. **`task_state: completed` stays the terminal assertion**, but only closes `truth=completed` when a satisfying `task_verification` exists for the task's `closure_type`. Without it, the completion is preserved as an **ignored terminal attempt** with a reason (`missing_verification | invalid_verifier | human_token_required`) — extending the existing `ignored_terminal_attempts` pattern, **never dropped silently**.
5. **HEAD-reconciliation by closure type:** a completion requires current HEAD; if HEAD moved since the actor's last read — auto: self-reconcile if no scope overlap, else flag; peer: flag to the peer; human-gated: surface to the human, pause until confirmed.
6. **Back-compat:** legacy tasks without `closure_type` parse as legacy/advisory (current behavior) until a workspace flips enforcement; old completed tasks are **not** retroactively invalidated; new tasks under this spec require the creation-time closure fields. Machine rejection of an invalid completion can come later — **projection-first enforcement** already makes "work complete ≠ outcome complete" visible on the trail now.

Net: creation records set the contract; `task_verification` proves it was satisfied; `task_state` records terminal truth only when the relevant verification exists. Preserves the separation between claim ownership, start authorization, closure verification, and terminal truth.

## 7. Design vs build
**This spec (structure + rules):** the three states, the gates, the closure types, the `task_verification` lane, delegation-as-grant. **NOT built:** the runtime that enforces the closure gate / human-auth-token check. Until that lands (rides the identity build track), closure discipline is advisory — but the classification, baseline, and verification records are written now, which already breaks the "self-close + report outcome" loop by making missing verification *visible on the trail*.

## 8. Open items / sequencing
1. ✅ Ratified the §6 schema boundary (`task_verification` lane + gated terminal truth).
2. Build track: feasibility — where the closure gate + `task_verification` projection land in the handler.
3. Owner: the Path-2 scoring thresholds (§3.3) — protocol-defined, owner-set.
4. Build track: the closure gate + human-auth-token check (rides identity enforcement); projection-first first.
5. Downstream: this is the mechanism that makes "outcome complete" real instead of self-asserted.
