# @guided-context-ledger/core

Transport-agnostic core runtime for the **Guided Context Ledger (GCL)** — the auditable provenance layer for multi-agent work.

This package is the engine, with no transport or MCP dependency. It gives you:

- **Workspace I/O** — read/write a plain-Markdown workspace (`Workspace`).
- **The append-only coordination trail** — events, claims, leases, `orient`/`needs_me`, task pool projections (`EventLog`).
- **The content-addressed revision ledger** — `HEAD`, CAS advance, hash-linked revisions with declared-vs-derived provenance (`GclLedger`).

It is the shared substrate the reference connector is built on. Bring your own transport (MCP, HTTP, CLI) on top of it.

```bash
npm install @guided-context-ledger/core
```

```ts
import { Workspace, EventLog, GclLedger } from "@guided-context-ledger/core";
```

For the protocol itself, the starter workspace, and a runnable MCP connector, see the monorepo:
**https://github.com/guided-context-ledger/guided-context-ledger**

Apache-2.0. Pre-1.0 alpha — interfaces may change between minor releases (see the repo `CHANGELOG.md`).
