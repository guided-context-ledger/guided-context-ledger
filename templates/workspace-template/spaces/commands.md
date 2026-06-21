---
gcl_version: 0.1.0
file_type: space
title: Commands
scope: global
status: active
written_by: <your-actor-id>
written_at: <ISO 8601>
authoritative: true
---

# Commands Space

Workspace-level shorthands an agent recognizes on arrival. Starter set below; extend as needed.

| Command | Meaning |
|---|---|
| `orient` | Wake up oriented: load identity, active constraints, what's addressed to me, and the delta since I last acted. |
| `sync_cold` / `sync_fresh` | Treat as no-prior-context; reconstruct entirely from the workspace (orient + identity + ledger delta). |
| `handoff` | Declare a task complete or paused for pickup, with objective, status, open questions, and next actions. |
