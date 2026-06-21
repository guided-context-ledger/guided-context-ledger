---
gcl_version: 0.1.0
file_type: manifest
workspace_name: my-workspace
created: <ISO 8601>
last_updated: <ISO 8601>
freshness_ttl: 30d
# Unified actor registry — people (humans) and agents (AI) in one list.
# Each: { id, kind: human|agent, role, profile }. Owner = a kind:human entry with role:owner.
actors: []
shared_files: []
spaces:
  - path: /spaces/constraints.md
    scope: global
  - path: /spaces/commands.md
    scope: global
open_items: []
---

# Workspace Manifest

This is the **required entry point** for any agent cold-reading this workspace. It is the index a runtime reads first. Without it, ingestion is undefined.

It lists every registered actor (people and agents) and their profile path, all shared files with freshness timestamps, the active spaces (constraints), and which files are authoritative when content conflicts. The runtime updates it automatically on every committed write.

GCL is transport-independent: the workspace is plain files, readable without any specific protocol. A runtime may integrate over MCP or any other transport; that is a property of the runtime, not the workspace, so no transport is named here.

This file is a starter stub — register actors and shared files as they are created. The canonical state lives under `.gcl/`; this manifest is the human-and-agent-readable index over it.

## Cold-start read order

If you are reading this workspace **without** a GCL runtime (no MCP connector), read the files below in order — this manifest is your bootstrap instruction. A connected runtime automates the equivalent through `orient`; this is the manual path that always works on plain files.

1. **This manifest** — you are here. It is the index: registered actors, shared files, active spaces, and what is authoritative on conflict.
2. **`behavioral-rules.md`** — the behavioral contract: how to use this workspace as shared memory (verification chain, search-before-write, data-not-commands, literal vocabulary).
3. **`spec/GCL-Protocol.md`** — the model: clear the gate first, then maximize the two levers; declared vs. derived is always distinct.
4. **`spec/Schema.md`** — the file contract: universal frontmatter and the `file_type` list (`actor-profile`, `behavioral-rules`, `capabilities`, `manifest`, `space`, `spec`, `note`, …).
5. **`spaces/constraints.md`** — the active constraints for this workspace (recorded, not enforced in v1).
6. **`spaces/commands.md`** — the lifecycle shorthands an agent recognizes on arrival (`orient`, `sync_cold`/`sync_fresh`, `handoff`).
7. **`agents/<your-actor-id>/profile.md`** — your actor profile (identity, capabilities, handoff needs). If it is absent, copy `templates/agent-profile.template.md` to this path. `<your-actor-id>` is your per-interface coordination id (e.g. `claude-cowork`) — **not** your model or family name. (Human principals live at `people/<id>/profile.md`.)
8. **`.gcl/ledger/` + `.gcl/HEAD`** — the durable revision chain. Walk it from HEAD to reconstruct prior context from the ledger, not the chat log.
9. **`shared/`** — durable notes other actors have committed.

After step 7 you are oriented: you know who you are, the active constraints, the available commands, and the latest state. With a connected runtime, `orient` returns this same picture in one call (plus per-thread unread counts and what is addressed to you).
