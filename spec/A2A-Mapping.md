---
gcl_version: 0.1.0
file_type: spec
title: A2A → GCL Mapping (illustrative)
status: draft
written_by: claude-cowork
written_at: 2026-06-15
authoritative: false
---

# Recording A2A Interactions in the GCL Ledger

> **Doc-only and illustrative.** This shows *how* an A2A interaction maps onto GCL provenance events, to back the claim "GCL complements A2A." A working adapter is **deferred past v1** — this document is the mapping, not the implementation. Mapping fidelity to be verified against the live A2A spec by the schema lane.

## The relationship

[A2A (Agent2Agent)](https://a2a-protocol.org/) is how agents discover each other, advertise capabilities (Agent Cards), and exchange tasks/messages over JSON-RPC 2.0. A2A moves the work between agents.

GCL does not move messages and is not an A2A alternative. GCL **records the provenance** of A2A-coordinated work: who was delegated what, by whom, with what standing, what changed, and how a later agent reconstructs it. A2A is the conversation; GCL is the durable, inspectable record of what the conversation *did*.

## Mapping

| A2A concept | GCL ledger record |
|---|---|
| Agent Card (capability advertisement) | a `capabilities` declaration for that actor id — what it can do, recorded and attributable |
| Task created / delegated | an event (`type: handoff`) with `addressed_to` the executing actor + the objective; optionally a `claim` when the agent takes ownership |
| Task accepted / claimed | a `claim` (`claimed`) under the task event — establishes ownership + lease so peers don't double-take it |
| Message / artifact exchanged | an event carrying the content-origin chain (`originated_by`, `relayed_through[]`, `posted_by`) and a cited `origin_ref` |
| Task completed / failed | a `claim` (`completed`) + a committed revision whose envelope hashes the resulting artifacts (CAS) |
| Authority to act (who authorized it) | the provenance envelope's `authority_source` / `authority_scope` — declared, distinct from the executing actor |

## What this buys

After an A2A exchange, the GCL ledger answers — from plain files, no chat history — the questions A2A itself doesn't durably record:

- **What happened** and in what order (append-only event trail).
- **Who acted, and with what standing** (actor id + claim/lease + authority declaration).
- **What changed** (content-addressed artifacts in the revision envelope).
- **Whether it's been tampered with** (tamper-evident where hash-backed — detect, not prevent).
- **What's safe to do next** (open claims, unanswered `addressed_to`, `needs_me`).

## Scope discipline (what GCL does NOT do here)

- GCL does not implement A2A transport, discovery, or message delivery — that is A2A's lane.
- GCL does not require A2A; it records provenance for any coordination substrate (A2A, MCP, manual relay).
- The v1 deliverable is **this mapping + a reference stub** that writes one A2A-style exchange into the ledger as provenance events. A full bidirectional adapter and exposing GCL as an Agent Card capability are post-v1.

---
*A2A is how agents talk. GCL is the inspectable trail of what they did.*
