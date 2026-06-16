---
gcl_version: 0.1.0
file_type: spec
title: OKF Compatibility
status: active
written_by: claude-cowork
written_at: 2026-06-15
authoritative: true
---

# GCL ⇄ OKF Compatibility

GCL's **knowledge layer** is **aligned with** the **Open Knowledge Format (OKF)** — designed to interoperate with it — the open, vendor-neutral specification introduced by Google Cloud on June 12 2026 ("Introducing the Open Knowledge Format," Google Cloud Blog, by Sam McVeety and Amir Hormati) for representing organizational knowledge as a directory of markdown files with YAML frontmatter. OKF is positioned as format-not-platform — vendor-neutral, agent- and human-friendly, with no required proprietary SDK or runtime.

> Source: https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/

GCL does **not** claim authorship of the knowledge-packaging format. OKF defines that surface; GCL is designed to interoperate with it and credits it. What GCL adds is the **ledger layer** — coordination, provenance, and CAS integrity — which OKF does not address.

## What "aligned" means here

- **The notes are OKF-shaped.** GCL knowledge files are markdown + YAML frontmatter in a directory, shippable in git and readable on GitHub — the OKF shape. An OKF-aware reader can open GCL's knowledge files as markdown+frontmatter bundles; full field-level conformance (e.g. OKF's `type` key) is a roadmap item — see the mapping below.
- **GCL frontmatter is a superset.** GCL files carry OKF-style descriptive frontmatter plus GCL coordination fields (`written_by`, `written_at`, provenance, status/tombstoning). The extra keys are additive; an OKF reader ignores what it doesn't use.
- **The ledger is out of OKF's scope, by design.** `.gcl/` (HEAD, the revision ledger, governance) is GCL-specific. OKF describes *what knowledge is*; GCL's ledger describes *who did what, when, with what standing*.

## Field mapping (GCL ⇄ OKF)

GCL is OKF-*shaped* but does not yet emit OKF's descriptive keys verbatim. v0.1 alignment:

| OKF v0.1 key | GCL field | Status |
|---|---|---|
| `type` | `file_type` | named differently; a `type` alias/emitter is a roadmap item |
| `title` | `title` | present on docs/specs/spaces |
| `description` | (in body) | not a frontmatter key in GCL v0.1 |
| `tags` | — | not in GCL v0.1 |
| `timestamp` | `written_at` / `last_updated` | present, GCL-named |

Until a `type` emitter lands, public wording stays "OKF-aligned / interoperable," not "conformant."

## The clean division

| Concern | Owner | Layer |
|---|---|---|
| Knowledge packaging (markdown + frontmatter directory) | **OKF** (Google Cloud) | knowledge |
| Coordination ledger, claims/leases, handoffs | **GCL** | ledger |
| Declared-vs-derived provenance + CAS integrity | **GCL** | ledger |
| Transport (MCP, etc.) | transport protocol | below both |

## A2A (Agent2Agent)

A2A is the complementary *comms* standard — how agents discover each other and delegate tasks. GCL is not an A2A alternative; it records the provenance of A2A-coordinated work: who was delegated what, what they did, what changed, with what standing. The detailed A2A interop design — recording A2A interactions into the ledger, and exposing GCL as an Agent Card capability — is in progress. The principle mirrors OKF: ride the established standard, add the auditable ledger it lacks.

## Positioning

> A2A is how agents talk. OKF is what they read. GCL is the inspectable record of what they did.

A team can run A2A for coordination and OKF for portable knowledge, and add GCL when they need the work to be owned, attributable, and auditable across agents and sessions. GCL complements both and competes with neither.

---
*Knowledge layer aligned with OKF (© Google Cloud, 2026). Ledger layer is GCL's own.*
