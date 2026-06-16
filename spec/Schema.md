---
gcl_version: 0.1.0
file_type: spec
title: Schema
status: active
written_by: claude-cowork
written_at: 2026-06-15
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
file_type: [brain | behavioral-rules | capabilities | active-projects |
            decision-log | assumptions | session-flags | vocabulary-lock |
            user-profile | manifest | space | spec | note]
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
---
```

`written_by` and `written_at` are required on **all** files — write attribution is a hard interoperability requirement, confirmed independently across multiple vendors. A file carries only the contextual fields that apply to it; "present but unset" is expressed by omission, not an empty key.

## Versioning & tombstoning

- Every change increments `version` (major = structural, minor = content, patch = clarification).
- Superseded content is **never deleted**. It is marked `status: superseded` with `superseded_by`, `superseded_date`, and `superseded_reason`. This preserves the audit trail while signaling what is no longer operative.

## Identity: per-interface coordination actor ids

Coordination keys on a **distinct actor id per interface**, not per model family. Two interfaces of the same model (e.g. a desktop app vs a CLI) are distinct actors for coordination because they have different tool surfaces and operational reality. Family grouping is display/context metadata only and must never collapse presence, cursors, claims, or "what's addressed to me" across siblings. A workspace resolves an actor's identity declaration through its registry/index, not a hardcoded path.

## Core agent files

| File | Responsibility |
|---|---|
| `users/{actor}/brain.md` | Agent identity: how it's wired, memory model, attention model, what it needs for a clean handoff. Canonical home for identity. |
| `behavioral-rules.md` | Durable hard/soft rules, applied automatically unless overridden in-session. Versioned. |
| `capabilities.md` | Environment-specific capabilities: transport, tools, memory, permissions, constraints. Never assumed from another instance. |
| `active-projects.md` | Current project state, one entry per project. |
| `decision-log.md` | Durable reasoning history — every significant decision with rationale, alternatives, confidence, and downstream implications. |
| `assumptions.md` | Explicit, visible assumptions with basis, risk-if-wrong, and validation method. Kept separate from decisions. |
| `session-flags.md` | Open threads and continuity signals: open-question, pending-decision, follow-up, warning, conflict. |
| `vocabulary-lock.md` | Terminology that must not drift; applied to all outputs automatically. |
| `user-profile.md` | Who the human is and how they operate. Human has final authority over its contents. |

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

Agents differ in context window size and attention model (recency-biased vs uniform). Each agent declares a `context_preference` (`compressed | complete | adaptive`) in `brain.md`/`capabilities.md`, and the runtime serves content accordingly. Because file position cannot be relied on as a universal priority signal, an explicit priority declaration — not file order — is the only architecture-agnostic priority mechanism.

## Conformance checklist

A GCL-conformant implementation must: implement `workspace.manifest.md` at root; include the required universal frontmatter (`gcl_version`, `file_type`, `written_by`, `written_at`, `status`, `authoritative`) on all files, with contextual fields where applicable; key coordination on per-interface actor ids; follow the decision/assumption/flag record schemas; tombstone rather than delete; use `type: conflict` rather than silent overwrite; respect an explicit priority declaration over file position; keep the ledger append-only; and never reference transport-specific constructs in workspace files.
