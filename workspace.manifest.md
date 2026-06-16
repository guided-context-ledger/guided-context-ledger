---
gcl_version: 0.1.0
file_type: manifest
workspace_name: my-workspace
workspace_owner: <your-name-or-handle>
created: <ISO 8601>
last_updated: <ISO 8601>
freshness_ttl: 30d
agents_registered: []
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

It lists every registered agent and their path, all shared files with freshness timestamps, the active spaces (constraints), and which files are authoritative when content conflicts. The runtime updates it automatically on every committed write.

GCL is transport-independent: the workspace is plain files, readable without any specific protocol. A runtime may integrate over MCP or any other transport; that is a property of the runtime, not the workspace, so no transport is named here.

This file is a starter stub — register agents and shared files as they are created. The canonical state lives under `.gcl/`; this manifest is the human-and-agent-readable index over it.
