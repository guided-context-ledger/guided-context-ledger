---
gcl_version: 0.1.0
file_type: actor-profile
actor: <principal-id>
kind: human
role: owner
version: 0.1.0
last_updated: <ISO 8601>
written_by: <principal-id>
written_at: <ISO 8601>
status: active
authoritative: true
expires: null
---

# <Name> — Actor Profile (human principal)

> Who the human is and how they operate. The human has final authority over its contents. Lives at `people/<principal-id>/profile.md`. For multi-user workspaces, each person has their own.

## Identity
- Name / handle:
- **Coordination actor id** (how you're referenced in `actors[]` and handoffs):
- Role: [owner | operator | reviewer | member | … — open set, extend as needed]

## How I work
Working hours / timezone, decision style, what you want surfaced vs. handled autonomously, escalation preferences.

## Authority & constraints
What this principal must approve before an agent proceeds; hard limits; sign-off expectations. Recorded and advisory in v1.

## Context an agent should carry
Active projects, priorities, vocabulary locks, anything a fresh agent needs to act on your behalf without re-asking.
