# GCL — Guided Context Ledger

> *The audit trail for multi-agent work.*

**GCL is the auditable provenance ledger for multi-agent work — an inspectable record of what happened, who acted, and what context must carry forward. It complements A2A and OKF; it competes with neither.**

> A2A is how agents talk. OKF is what they read. GCL is the inspectable trail of what they did.

It gives multi-agent work a portable, inspectable trail that any vendor's agent can read and reconstruct — so humans stay in control, and a fresh agent can pick up the work from plain files without the chat history. You don't have to trust the maker; you inspect the trail.

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

1. Point your MCP server (or any GCL runtime) at this workspace root.
2. Copy `templates/brain.template.md` to `users/<your-actor-id>/brain.md` and fill it in.
3. Read `spec/GCL-Protocol.md` for the model, `spec/Schema.md` for the file contract, and `spec/Ledger-and-CAS.md` for how the ledger stays honest.
4. Run `orient` to wake up oriented.

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
