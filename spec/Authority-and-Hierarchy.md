---
gcl_version: 0.1.0
file_type: spec
title: Authority & Hierarchy
status: active
written_by: claude-cowork
written_at: 2026-06-30
last_updated: 2026-06-30
authoritative: true
tags: [hierarchy, authority, permissions, governance, structure, locked]
---

# Authority & Hierarchy

> **Status: Active — owner-directed.** This locks the *structure*: the canonical hierarchy every workspace uses. The STRUCTURE (the four levels, ownership flow, the permission/grant model, the verified-actor seam) is in place and canonical now. ENFORCEMENT (live grant-checking, human-gated closure tokens, multi-workspace hosting) is the parallel build track that binds to identity/attestation as it lands — see "What is in place vs the parallel track" below.

## 0. The governing law (locked)
Anything required for GCL to function correctly must live at the **protocol level**, never depend on a specific vendor, transport, or a sufficiently-smart agent noticing. The hierarchy and permissions are therefore transport-agnostic. (Framing: GCL is the ocean, workspaces are ships, agents are crew, HEAD is the current every vessel feels.)

## 1. The hierarchy (the "box")
Four nested levels. This single structure simultaneously carries authority, permissions, context-scoping, and the task lifecycle.

```
GCL Root
  └─ Workspace
       └─ Project
            └─ Task
```

- **Root** — organization level. The top authority. Controls workspace creation, org-wide policy, and who may initialize workspaces. Owns everything beneath it by default. The template library is a Root-level resource.
- **Workspace** — team/department level. A portable, self-describing unit with exactly one authoritative HEAD. Has an owner, granted by Root. Authority scoped to the workspace by default. Instantiable from Root-controlled templates.
- **Project** — a workstream within a workspace. Has an owner, granted by the Workspace owner. Authority scoped to the project by default. (Already partially real: the engine stores per-project ledger lanes at `.gcl/projects/<project>/`.)
- **Task** — not *owned*, **claimed**. Picked up by an actor with matching capability + authority scope under the existing claim/lease model. The task lifecycle (assumption gate, complexity gate, closure types — §6) lives here.

## 2. Authority model
- **Default authority flows DOWN.** Each level's owner holds authority over everything beneath it unless explicitly narrowed.
- **Explicit grants can cross ANY boundary** (§3). A grant is the mechanism for crossing the default-downward flow.
- **No grant elevates above the grantor's own level.** You cannot give access you do not hold.
- Ownership at each level is *granted by the level above* (Root → Workspace owner → Project owner); Tasks are claimed, not owned.

## 3. Permission model (the Google-Drive model)
Sharing works like Drive: grant access at any level; everything beneath inherits it automatically; new resources added under a shared parent inherit the grant with no re-grant.

A **grant** has three components:
- **What** — the resource: any level of the hierarchy (Root/Workspace/Project) or a specific resource (a note, a thread).
- **Who** — a **verified actor** with attested identity at the protocol level (§4).
- **Level** — four levels, each inheriting the capabilities of the levels below:
  - **Read** — full visibility, no write.
  - **Contribute** — add, append, propose work (events, draft notes, claim tasks).
  - **Approve** — verify/close tasks and authorize within scope.
  - **Admin** — grant/revoke up to one's own level; full control of that resource.

**Rules (locked):**
- Grants cannot elevate above the grantor's own level.
- **Revocation is a ledger event** — auditable, immediate.
- Access to a resource does **not** bleed into sibling resources at the same level.
- **Every grant is ledger-tracked**: who granted, when, at what level, on what resource. (Grants live in a governance lane — `.gcl/governance/grants.jsonl` — append-only, like every other ledger lane.)
- **Outsider/contribution surface** = a scoped *Contribute* grant to a `contributions/` resource only, with **no upward inheritance**. Outsiders cannot self-grant; a member with sufficient authority issues it.

## 4. The verified-actor seam (the one cross-cutting dependency)
Every authority-bearing action — issuing a grant, closing a human-gated task, committing to the ledger — binds to a **verified actor**, not a self-declared one. *How* identity is verified is defined separately in **`spec/Identity-and-Attestation.md`** (the parallel prerequisite track): a protocol-level session token derived per-transport via attestation adapters, trusted by the ledger over any agent's self-declaration. This spec depends on that seam but does not define it.

Until attestation lands, enforcement of §2–§3 is **advisory** (consistent with the current recorded-but-agent-enforced constraints posture: recorded, agent-enforced, not yet machine-enforced). The structure, ownership records, and grant trail are real and canonical now; the *gate* that rejects an unauthorized action becomes machine-enforced when identity does.

## 5. The hierarchy as context scope
Each level is also a **context filter**. Each maintains a living **picture** (a compressed, always-current summary pushed to an arriving actor — role/authority scope, what's in flight, blockers, navigation pointers). The **pieces** (notes, events, provenance) are the full detail, **pulled on demand**, never pushed wholesale. Task-level is the cheap default; higher levels load on request. Attribution travels with the picture, not just the raw pieces. Full treatment is covered in a separate Context-Model spec (not yet published).

## 6. The Task level & lifecycle
At the Task level, before work begins on a qualifying task:
- **Assumption-declaration gate** — the actor declares its interpretation of the desired outcome; the authorized human confirms/corrects; the confirmed assumption locks into the task record as the baseline for verification and closure.
- **Complexity gate** — Path 1: irreversibility is a hard gate (irreversible ⇒ declaration + human confirm, no exceptions). Path 2: reversible work is scored on scope / ambiguity / dependencies against a threshold.
- **Three closure types** — *auto-closeable* (mechanical, verified by a **different** actor than the executor), *peer-reviewed* (independent agent verifies), *human-gated* (a verified human authorizes; the ledger is to reject a completion event lacking a valid human-authorization token once enforcement lands — advisory until then). **The authorized human sets complexity + closure type at task creation — never the executing agent.** Full treatment: `spec/Task-Lifecycle.md` (separate).

## 7. Cross-workspace (v1 scope)
v1 grants are **workspace-scoped**. **Cross-workspace grants** (a grant in workspace A conferring access in workspace B) are **v2**, riding a cross-workspace resolver + bridge/receipt model (covered in a separate Cross-Workspace spec, not yet published). v1 keeps each workspace's authority self-contained.

## 8. What is in place now vs the parallel track
**In place / canonical now (this spec + the manifest authority block):**
- The four-level hierarchy and its ownership flow.
- The permission/grant model (components, four levels, inheritance, rules, the grants ledger lane).
- Root + Workspace ownership of this workspace, recorded in `workspace.manifest.md`.
- The Project level formalized (owners + the existing `.gcl/projects/<project>/` lanes).
- The verified-actor seam and the cross-workspace v1 boundary.

**Parallel build track (binds in as it lands — NOT claimed complete here):**
- `spec/Identity-and-Attestation.md` — the verification mechanism behind the seam (§4). Prerequisite for *machine-enforced* grants, human-gated closure, and the human-auth token.
- Engine enforcement of grants/closure (build lane), and multi-workspace hosting for cross-workspace grants (v2).
- A separate Context-Model spec (forthcoming) and `spec/Task-Lifecycle.md` — the §5/§6 details as their own specs.

This separation is deliberate and is the honest answer to "is it done?": **the structure is done and present; enforcement is the next domino and it is gated on identity.**

## 9. Sequencing for dependent objectives
1. **This spec + manifest authority block (DONE on landing).**
2. `spec/Identity-and-Attestation.md` design (parallel, prerequisite for enforcement).
3. `spec/Task-Lifecycle.md` + the Context-Model spec (depend on this hierarchy as their frame).
4. Engine: grants ledger lane + advisory grant resolution → machine-enforced once identity lands.
5. v2: cross-workspace grants on the cross-workspace resolver.
