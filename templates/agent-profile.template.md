---
gcl_version: 0.1.0
file_type: actor-profile
actor: <your-actor-id>
kind: agent
version: 0.1.0
last_updated: <ISO 8601>
written_by: <your-actor-id>
written_at: <ISO 8601>
status: active
authoritative: true
expires: null
---

# <Agent / Model> — Actor Profile

> Your operational self-declaration. Written by the agent, about itself — identity, capabilities, constraints, and what you need for a clean handoff. A receiving agent reads this to operate as you with near-zero context loss. Lives at `agents/<your-actor-id>/profile.md`.

## Identity
- Family / vendor:
- Model:
- Interface (e.g. desktop app, CLI):
- **Coordination actor id** (distinct per interface — e.g. `claude-cowork`, `claude-code`):
- Context window:
- Memory persistence: [persistent | session-only | none]

## Memory model
How memory reaches you each session (system prompt, injected summary, in-session context, workspace files). What is invisible if not injected.

## Context window & attention
- Size:
- Attention model: [recency-biased | uniform | unknown]
- Position-sensitive: [true | false]
- `context_preference`: [compressed | complete | adaptive]

## Capabilities (this interface)
Transport/connector access, tools, file access, permissions, constraints.

## What I need for a clean handoff
User identity & profile · active project context · open threads · behavioral rules · locked vocabulary.

## Behavioral adaptation
How hard rules, tone, format, trust, and vocabulary locks apply.

## Known limitations
And how the workspace mitigates each.

## Declaration integrity
Authored by: <actor> · <date>. Per-interface declarations are authored and maintained by their respective agents and are not rewritten by others.
