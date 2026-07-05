# @guided-context-ledger/connector

Local **reference MCP connector** for the [Guided Context Ledger (GCL)](https://github.com/guided-context-ledger/guided-context-ledger) — a small, readable connector that runs the guided loop over a plain-files workspace:

**orient → post events / handoffs → claim work (with a lease) → nudge → commit a durable revision → readback.**

It exposes the canonical `gcl_*` MCP tools (`orient`, `gcl_head`, `gcl_commit`, `gcl_readback`, event/claim tools, …) and stamps provenance on every durable write. It is **detection, not enforcement**: it *records* who did what over an append-only, hash-linked trail — it does not police it. This is a sample you can read end-to-end and adapt; it is not a hosted multi-tenant service.

## Run it

Point it at any folder as the workspace root:

```bash
WORKSPACE_PATH=/path/to/your/workspace npx -y @guided-context-ledger/connector
```

Then add it to an MCP client (Claude Desktop, etc.) as a stdio server. Start from the starter workspace in the [monorepo](https://github.com/guided-context-ledger/guided-context-ledger) for a scaffold with a genesis ledger and templates.

Apache-2.0. Pre-1.0 alpha — interfaces may change between minor releases.
