# GCL — Guided Context Ledger

GCL aims to preserve workspace continuity across complex systems involving people, places, and technology. This is achieved by ensuring the *what, when, and why* is recorded, deciding factors are known, and the state of work is preserved — so any person or agent, in any session, using any vendor, can pick up exactly where things left off.

GCL is not a security product, not a competitor to A2A or OKF, and not tied to any vendor or transport. It complements both standards and is designed to outlive any single integration.

## Start here

### No install — 60 seconds

A GCL workspace is plain files. No account, no integration required.

1. Open any AI assistant that can read files — Claude, ChatGPT, Gemini, or similar.
2. Point it at this workspace and say: *"Read `workspace.manifest.md` first, then follow the cold-start read order inside it."*

Done. The manifest bootstraps itself. Any agent that can read markdown can orient.

### Connected — live multi-session setup

When you want an agent to retrieve context and write back to the ledger safely, connect a GCL runtime via MCP. The connector is published on npm as [`@guided-context-ledger/connector`](https://www.npmjs.com/package/@guided-context-ledger/connector) — **no clone required.**

#### Option A — npx (recommended)

No install step and no build: point your MCP client at the published connector.

1. Open your MCP client config file:
   - **Claude Desktop:** Settings → Developer → Edit Config (`claude_desktop_config.json`)
   - **Claude Code:** use the one-liner in step 3 below
   - **Other MCP clients:** check your client's documentation for the config location
2. Add the following block, setting `GCL_WORKSPACE` to the workspace on your machine:

   ```json
   {
     "mcpServers": {
       "guided-context-ledger": {
         "command": "npx",
         "args": ["-y", "@guided-context-ledger/connector"],
         "env": { "GCL_WORKSPACE": "/abs/path/to/your/workspace" }
       }
     }
   }
   ```

3. **Claude Code shortcut** — skip steps 1–2 and run this instead:

   ```bash
   claude mcp add guided-context-ledger -e GCL_WORKSPACE=/abs/path/to/your/workspace -- npx -y @guided-context-ledger/connector
   ```

4. Fully close and restart your MCP client. Configs don't take effect on an already-open connection.

#### Option B — from source (for development)

If you want to run the connector from a local checkout — to modify it or track `main`:

1. Clone and build:

   ```bash
   git clone https://github.com/guided-context-ledger/guided-context-ledger.git
   cd guided-context-ledger
   npm install
   npm run build
   ```

2. Point your MCP client config at the built entrypoint:

   ```json
   {
     "mcpServers": {
       "guided-context-ledger": {
         "command": "node",
         "args": ["/abs/path/to/guided-context-ledger/packages/connector/dist/index.js"],
         "env": { "GCL_WORKSPACE": "/abs/path/to/your/workspace" }
       }
     }
   }
   ```

3. Fully close and restart your MCP client.

### Use

1. In your MCP client, call `orient`.
2. You should see the server version, your workspace path confirmed, and — if this is a new workspace — first-run guidance walking you through setup.
3. If `orient` echoes back the `GCL_WORKSPACE` path you set, you're connected and ready.

### First run

If your workspace is new, `orient` will tell you. From there your agent walks you through the rest — creating your profile, registering in the manifest, and making your first commit. You don't need to do anything manually unless you want to.

## What GCL is

GCL has two layers:

1. **The knowledge layer — OKF-aligned.**
   Notes, decisions, identity, and project context live as plain markdown files with YAML frontmatter, aligned with the Open Knowledge Format. Any editor can read them. Any agent can consume them. No lock-in.
2. **The ledger layer — what makes GCL, GCL.**
   An append-only, content-addressed coordination ledger: event and handoff trail, work ownership via claims and leases, declared-vs-derived provenance, and tamper-evident integrity. This is the part OKF doesn't have. When something happened, who did it, and why — it's in the ledger, and absence is as visible as presence.

## Workspace layout

```
my-workspace/
  workspace.manifest.md      ← required entry point; the index a cold agent reads first
  .gcl/                      ← AGENT DOMAIN — canonical, content-addressed source of truth
    HEAD                     ← current canonical revision pointer (starts at rev_genesis)
    ledger/revisions.jsonl   ← append-only commit ledger
    protocol/                ← the laws (onboard / orient / commit / authority specs)
    agents/{actor}/          ← per-agent onboarding status + capabilities (machine files)
    governance/              ← violations + open conflicts
  agents/{actor}/profile.md  ← agent actor profile (identity, capabilities, handoff needs)
  people/{actor}/profile.md  ← human principal profile
  spaces/                    ← the contract: constraints, commands, behavioral rules
  shared/                    ← cross-actor working space
  workspaces/{name}/         ← separate, portable units of project context
  templates/                 ← starter frontmatter + actor-profile templates
```

## Specs

| Doc | What it covers |
| --- | --- |
| `spec/GCL-Protocol.md` | The model, decision lens, invariants |
| `spec/Schema.md` | Universal frontmatter + file-type contract |
| `spec/Ledger-and-CAS.md` | HEAD, revision ledger, deterministic hashing |
| `spec/OKF-Compatibility.md` | Knowledge layer alignment with OKF |
| `spec/A2A-Mapping.md` | How A2A interactions record as GCL provenance |

## License

Apache 2.0 — permissive, with explicit patent grant. Safe to adopt and build on.

---

GCL — Guided Context Ledger. Open. Transport-independent. Community-owned.
Knowledge layer aligned with OKF (© Google Cloud). Ledger layer is GCL's own.
