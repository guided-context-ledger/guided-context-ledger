# GCL — Guided Context Ledger

**GCL is the auditable provenance ledger for multi-agent work — an inspectable record of what happened, who acted, and what context must carry forward. It complements A2A and OKF; it competes with neither.**

> Put simply: GCL provides the cleanroom for multi-agent work — strict inside, transparent outside.

GCL sits *above* the transport protocol (MCP is one current reference integration) and is designed to outlive it. A GCL workspace is just plain files — markdown, YAML frontmatter, and append-only JSONL — readable in any editor, diffable in git, and consumable by any agent with no custom integration.

---

## What GCL is (and isn't)

GCL has two layers, with two different jobs:

1. **The knowledge layer — OKF-aligned.** The notes an agent reads (identity, rules, project context, decisions) are a directory of markdown files with YAML frontmatter. This layer is **aligned with Google Cloud's Open Knowledge Format (OKF)** — introduced on the [Google Cloud Blog](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/), June 12 2026, by Sam McVeety and Amir Hormati. GCL does not reinvent the knowledge-packaging format — it follows OKF's markdown+frontmatter shape and credits it as the origin of that standard. (Field-level mapping and the path to full conformance are in `spec/OKF-Compatibility.md`.)

2. **The ledger layer — what makes GCL, GCL.** A content-addressed, append-only coordination ledger: an event/handoff trail, claims and leases for work ownership, declared-vs-derived provenance, and tamper-evident CAS integrity. This is the part OKF does not have — OKF packages static knowledge; GCL is the live coordination, memory, and provenance ledger on top.

**GCL is "the record you can audit, where bad behavior is detectable and expensive" — low-trust by construction.** You don't have to trust the maker; you inspect the trail. The integrity is *tamper-evident where backed by hashes*, not tamper-proof. It is *not*:
- a security or encryption product, and it makes no formal security guarantee — it's a reference implementation pending external review,
- a claim that the agents or models themselves are safe (that's the provider's job),
- a competitor to A2A (agent comms) or OKF (knowledge format) — it complements them,
- a policer of external systems, or ever a bypass or shield for safety, approvals, or provider terms.

---

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
  users/{actor}/brain.md     ← agent identity (canonical home for identity)
  spaces/                    ← the contract: constraints, commands, behavioral rules
  shared/                    ← cross-agent working space
  workspaces/{name}/         ← separate, portable units of project context
  templates/                 ← starter frontmatter + brain templates
```

The `.md` files humans open are read-only **projections** of canonical `.gcl/` state. Human-authored notes are a separate native lane and are never overwritten by projection.

---

## Start here

GCL works at two depths. Start with the first; reach for the second when you want it.

### The 60-second path — no install, no account

You don't have to install or connect anything to see what GCL does. A GCL workspace is just plain files.

1. Open any AI assistant that can read a folder of files — Claude (desktop or Cowork), ChatGPT with file access, Gemini, or similar.
2. Point it at this workspace folder and tell it: **“Read `workspace.manifest.md` first, then follow the cold-start read order inside it.”**
3. That's it. The manifest is its own bootstrap instruction — it lists what to read and in what order, and the agent reconstructs the context from the plain files. No protocol, no integration, no lock-in.

This is the proof of the whole idea: any vendor's agent can pick the work up from the files alone. If it can read markdown, it can orient.

### The connected path — for a live, multi-session setup

When you want an agent to *retrieve* context instead of reconstruct it — and to write back to the ledger safely — connect a GCL runtime (today, an MCP server) at the workspace root.

1. Connect the runtime at this workspace root.
2. Copy `templates/brain.template.md` to `users/<your-actor-id>/brain.md` and fill it in — this is your agent's identity. (`<your-actor-id>` is the per-interface coordination id, e.g. `claude-cowork` — not a model or family name.)
3. Run `orient` to wake up fully loaded: the active constraints, your brain, who else is around, and what's unread since you last acted — the same picture the manual read order builds, in one call.
4. From there the connector gives you the ledger: notes with conflict-safe (CAS) writes, the event/handoff trail, claims and leases for owning work, and `gcl_commit` / `gcl_readback` for durable session boundaries.

The connector is **detection, not enforcement** in v1 — it makes bad or conflicting writes visible and expensive, not impossible. A hosted runtime and server-side enforcement are the planned fast-follow.

Want the model behind it? Read `spec/GCL-Protocol.md` (the model), `spec/Schema.md` (the file contract), and `spec/Ledger-and-CAS.md` (how the ledger stays honest).

---

## Specs in this repo

| Doc | What it covers |
|---|---|
| `spec/GCL-Protocol.md` | The model, the decision lens, the invariants |
| `spec/Schema.md` | Universal frontmatter + file-type contract |
| `spec/Ledger-and-CAS.md` | HEAD, the revision ledger, deterministic hashing |
| `spec/OKF-Compatibility.md` | How the knowledge layer aligns with OKF (field mapping) |
| `spec/A2A-Mapping.md` | How A2A interactions record as GCL provenance (illustrative) |

---

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE). Permissive, with an explicit patent grant, so the standard stays safe to adopt and build on.

---

*GCL — Guided Context Ledger. Open. Transport-independent. Community-owned.*
*Knowledge layer aligned with OKF (© Google Cloud). Ledger layer is GCL's own.*
