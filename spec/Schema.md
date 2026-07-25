---
gcl_version: 0.1.0
file_type: spec
title: Schema
status: active
written_by: claude-cowork
written_at: 2026-06-15
last_updated: 2026-06-30
authoritative: true
---

# GCL Schema — File Contract

GCL files are markdown with YAML frontmatter (OKF-aligned; see `OKF-Compatibility.md`). This doc defines the universal frontmatter and the file-type contract.

## Universal frontmatter

Every GCL file begins with this block. Fields split into **required** (on every file) and **contextual** (present only where they apply), grouped below. Field additions are always additive; fields are never removed, only deprecated and tombstoned.

```yaml
---
# --- required on every file ---
gcl_version: 0.1.0
file_type: [actor-profile | behavioral-rules | capabilities | active-projects |
            decision-log | assumptions | session-flags | vocabulary-lock |
            manifest | space | spec | note]
written_by: [coordination actor id]
written_at: [ISO 8601]
status: [active | archived | superseded]
authoritative: [true | false]
# --- contextual: include only when applicable ---
title: [human title (docs, specs, spaces)]
scope: [global | project | ... (spaces)]
actor: [coordination actor id of the author (agent/note files)]
version: [semver (files that version independently)]
last_updated: [ISO 8601 (files tracking a separate edit time)]
expires: [ISO 8601 or null (files with a TTL)]
superseded_by: [path to newer file (when status: superseded)]
superseded_date: [ISO 8601 (when superseded)]
superseded_reason: [why (when superseded)]
capabilities: [capability-token, ...]
conditional_capabilities:
  - token: [capability-token]
    when: [short condition]
provenance:
  actor_identity: [coordination actor id, when connector-stamped]
  principal: [human principal id, when connector-stamped]
  mediated_by: [mediator actor id, when connector-stamped]
  stamped_at: [ISO 8601, when connector-stamped]
cross_ref:
  workspace_id: [workspace id]
  origin_revision: [rev id or HEAD]
  evidence_revision: [rev id or null]
  object_kind: [note | event | revision | decision | assumption]
  local_ref: [workspace-local path/id]
---
```

`written_by` and `written_at` are required on **all** files — write attribution is a hard interoperability requirement, confirmed independently across multiple vendors. A file carries only the contextual fields that apply to it; "present but unset" is expressed by omitting, not an empty key.

## Versioning & tombstoning

- Every change increments `version` (major = structural, minor = content, patch = clarification).
- Superseded content is **never deleted**. It is marked `status: superseded` with `superseded_by`, `superseded_date`, and `superseded_reason`. This preserves the audit trail while signaling what is no longer operative.

## Manifest identity block

`workspace.manifest.md` may declare an `identity:` block as the workspace-scoped source for display labels:

```yaml
identity:
  protocol:
    id: gcl
    display_name: Guided Context Ledger
    short_name: GCL
  product:
    display_name: Reference Runtime
    server_name: gcl-runtime
  workspace:
    display_name: <workspace display name>
    slug: <workspace-slug>
  organization:
    display_name: <organization display name>
  public_labels:
    one_liner: <short public description>
```

`identity.workspace.*`, `identity.organization.*`, and workspace-scoped `identity.product.*` are for human-facing copy generated from or about this workspace. Reusable templates and generated workspace-facing notes should resolve those labels from the manifest rather than scattering literals. `identity.protocol.*` records the public protocol identity and is not ordinary white-label surface; protocol/API compatibility vocabulary such as `GCL`, `.gcl/`, `gcl_version`, and `gcl_*` remains literal unless a separate breaking/deprecation decision says otherwise.

## Identity: per-interface coordination actor ids

Coordination keys on a **distinct actor id per interface**, not per model family. Two interfaces of the same model (e.g. a desktop app vs a CLI) are distinct actors for coordination because they have different tool surfaces and operational reality. Family grouping is display/context metadata only and must never collapse presence, cursors, claims, or "what's addressed to me" across siblings. A workspace resolves an actor's identity declaration through its registry/index, not a hardcoded path.

## Capabilities

Actor profiles and `capabilities.md` may declare structured capability tokens in frontmatter. The canonical token vocabulary is closed but additive by decision:

```yaml
capabilities:
  - repo-access
  - filesystem-rw
  - shell
  - build
  - test
  - git
  - code-search
  - schema-review
  - connector-coord
  - event-write
  - note-read
  - note-write
  - ledger-commit
  - web
  - computer-use
  - app-mcp
  - design-critique
  - unreal-editor
conditional_capabilities:
  - token: repo-access
    when: user has connected a repository/workspace folder for this session
```

Task eligibility may be mechanically checked as `task.requires ⊆ actor.capabilities`. For backward compatibility, actors without a declared `capabilities:` block remain advisory/ungated until a workspace or engine policy explicitly requires capability declarations. Conditional capabilities are not assumed active unless the current session/tooling has verified the condition.

Each actor owns its own capability declaration. Other agents may propose a capability map, but they must not rewrite another actor's self-declaration without that actor's or the human owner's approval.

## Note-write attribution

Connector-mediated note writes use a hybrid attribution model:

1. **Current stamped axes in note frontmatter** — `provenance.actor_identity`, `provenance.principal`, `provenance.mediated_by`, and `provenance.stamped_at` record the current connector-stamped writer axes on the note itself, alongside the existing `written_by`/`written_at` fields for human readability and local inspection.
2. **Append-only write record** — every connector-mediated `write_note` / `append_note` also emits an append-only note-write record carrying the same axes, target path, timestamp, operation, and content hash/digest. This is the audit trail. Corrections are new records, never silent history rewrites.

Direct/local note writes stay byte-identical unless a connector/session actually stamps the additional axes. Legacy notes are not backfilled. Undefined provenance fields are omitted, not serialized as null/empty placeholders.

This hybrid model gives build code a self-contained current-note view without making frontmatter pretend to be the whole audit history. The append-only write record is authoritative for mutation history; the frontmatter block is the current state snapshot.

## Cross-workspace references

`cross_ref` uses the ratified cross-workspace-reference shape:

```yaml
cross_ref:
  workspace_id: ws_...
  origin_revision: rev_...   # or HEAD when explicitly allowed by the resolver
  evidence_revision: rev_... # optional; omit when absent
  object_kind: note          # note | event | revision | decision | assumption
  local_ref: shared/example.md
```

For note-kind references, prefer frontmatter `cross_ref:` first: it is human-readable, does not change existing revision hash recipes, and unblocks same-host workspace references with minimal migration risk. For event/revision/action-provenance references that must be tamper-evident, add a hashed `cross_ref` carrier in the action-provenance envelope under a future versioned stamp boundary (e.g. `STAMPED_FROM=0.3.0`), preserving pre-boundary IDs exactly.

Bridge and receipt records are append-only lanes, not in-place note mutations. Their storage should mirror the existing event-log pattern unless a later build decision proves a single-lane discriminator is simpler. Bridge/receipt records reuse the same `principal` / `actor_identity` / `mediated_by` axes as events and note-write records.

## Core actor files

Actors are **people** (humans) and **agents** (AI), registered in one unified manifest `actors[]` list — each `{ id, kind: human | agent, role, profile }`. `role` and `profile` are open; `kind` is the only closed enum (`system` reserved as a future lane). A workspace resolves a profile through the registry's `profile` path, defaulting by kind; registry membership never gates resolution.

| File | Responsibility |
|---|---|
| `agents/{id}/profile.md` (agent) · `people/{id}/profile.md` (human) | **Actor profile** — identity: how an agent is wired (memory/attention model) or who a person is and how they operate, capabilities, and what's needed for a clean handoff. `kind` distinguishes the shape; a human has final authority over their own profile. Default path by kind; the `actors[]` entry's `profile` is canonical when present. |
| `behavioral-rules.md` | Durable hard/soft rules, applied automatically unless overridden in-session. Versioned. |
| `capabilities.md` | Environment-specific capabilities: transport, tools, memory, permissions, constraints. May use the same structured capability-token vocabulary as actor profiles. Never assumed from another instance. |
| `active-projects.md` | Current project state, one entry per project. |
| `decision-log.md` | Durable reasoning history — every significant decision with rationale, alternatives, confidence, and downstream implications. |
| `assumptions.md` | Explicit, visible assumptions with basis, risk-if-wrong, and validation method. Kept separate from decisions. |
| `session-flags.md` | Open threads and continuity signals: open-question, pending-decision, follow-up, warning, conflict. |
| `vocabulary-lock.md` | Terminology that must not drift; applied to all outputs automatically. |

## Record schemas (essentials)

**Decision:**
```yaml
- decision_id: D-001
  timestamp: [ISO 8601]
  written_by: [actor]
  decision: [what was decided]
  rationale: [why]
  alternatives_considered: [list]
  confidence: [high | medium | low]
  made_by: [human | agent | joint]
  status: [active | superseded]
```

**Assumption:**
```yaml
- assumption_id: A-001
  assumption: [what is assumed]
  basis: [why held]
  confidence: [high | medium | low]
  risk_if_wrong: [what breaks if false]
  validation_method: [how to confirm/falsify]
  status: [active | validated | invalidated | superseded]
```

**Session flag:**
```yaml
- flag_id: [id]
  type: [open-question | pending-decision | follow-up | warning | conflict]
  description: [what needs attention]
  priority: [high | medium | low]
  status: [open | resolved]
```

## Conflict behavior

When two agents write contradictory content to shared space: **neither overwrites the other** — both are preserved with attribution, a `type: conflict` session flag is written, and the human arbitrates. Silent overwrite is never permitted.

## Context preference

Agents differ in context window size and attention model (recency-biased vs uniform). Each agent declares a `context_preference` (`compressed | complete | adaptive`) in its `profile.md`/`capabilities.md`, and the runtime serves content accordingly. Because file position cannot be relied on as a universal priority signal, an explicit priority declaration — not file position — is the only architecture-agnostic priority mechanism.

## Identity session and onboarding status

`spec/Identity-and-Attestation.md` defines the normative identity/session semantics. Schema records only the file/record contract by back-reference:

- `identity-session` is an allowed schema record type for normalized `GclSessionToken` material when a runtime persists or audits a session-token issuance/validation decision. The canonical shape is the token contract in `spec/Identity-and-Attestation.md`: `principal`, `mediated_by`, `actor_identity`, `attestation_tier`, `transport`, `adapter_id`, `derivation_method`, `issuer`, `audience`, `issued_at`, and `expires_at`. Protocol semantics, tier meaning, and adapter rules live in the identity spec, not here.
- `onboarding-status` is an allowed file type for `.gcl/agents/<actor>/onboarding-status.yml`. At minimum it must include `status` and `contract_accepted`; a committing actor is onboarded only when `status: complete` and `contract_accepted: true`. Implementations should surface the exact missing or invalid field when this gate fails. Optional audit fields include `contract_accepted_at` and `spaces_contract_version`.

These additions close a schema gap identified during review without changing the meaning of existing universal frontmatter. Full identity enforcement remains gated on the ratification/build path in `spec/Identity-and-Attestation.md`.

## Provenance: `principal_source` (how the principal was known)

The action-provenance envelope (schema ≥ 0.2.0, defined in `@guided-context-ledger/core`) carries `principal_source` alongside `principal_id` and `actor_identity`. It records HOW the accountable principal behind a write was established — a distinct axis from `attestation_tier` in `spec/Identity-and-Attestation.md` (which grades identity *strength* of a session token). Allowed values, weakest → strongest by the trust the runtime can place in the claim:

- `self_report` — an agent's bare declaration (weakest; the default when nothing stronger is available).
- `operator_local` — a direct **host-operator** action: someone with shell access on the host ran it (e.g. a batch host-operator genesis-mint script). Not a connector-mediated agent claim; host-access-gated, so it ranks above a bare self-report.
- `connector_session` — a real authenticated connector session established the principal.
- `org_verified` — an org roster authenticated the human (strongest).

Additive/never-removed like all schema enums. `mediated_by` is omitted on a direct/local write (incl. `operator_local`) — there is no connector channel to attest. Earlier genesis-tenant mints that predate this value carry `self_report`; those revisions are immutable and are NOT rewritten (auditable-trail: corrections are new records, never edits).

## Conformance checklist

A GCL-conformant implementation must: implement `workspace.manifest.md` at root; include the required universal frontmatter (`gcl_version`, `file_type`, `written_by`, `written_at`, `status`, `authoritative`) on all files, with contextual fields where applicable; key coordination on per-interface actor ids; follow the decision/assumption/flag record schemas; tombstone rather than delete; use `type: conflict` rather than silent overwrite; respect an explicit priority declaration over file position; keep the ledger append-only; preserve append-only note-write attribution for connector-mediated note mutation; resolve workspace-scoped display labels from the manifest identity block where present; use structured capability tokens where a workspace wants mechanical task eligibility; represent cross-workspace refs with qualified `cross_ref` records; and never reference transport-specific constructs in workspace files.
