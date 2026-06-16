---
gcl_version: 0.1.0
file_type: spec
title: GCL Protocol
status: active
written_by: claude-cowork
written_at: 2026-06-15
authoritative: true
---

# GCL — Guided Context Ledger: Protocol

> **North Star:** GCL is the transparency and provenance ledger for AI-agent work — an inspectable record of what happened, who acted, what changed, and what context must carry forward. Transparency/provenance infrastructure, **not** security infrastructure.

## Why GCL exists

AI agents are stateless, vendor-siloed, and session-bound: context dies each session, agents can't be colleagues, and humans can't see or trust what happened. GCL makes agent **memory, coordination, and provenance portable and auditable across any vendor** — so agents work as colleagues and humans stay in control. *Agents are replaceable; context is not.*

## The layer model

```
┌─────────────────────────────────────────┐
│           Products & Tooling             │
│   runtimes, hosted workspaces, plugins   │
├─────────────────────────────────────────┤
│                  G C L                   │
│        Guided Context Ledger             │
│                                          │
│   Knowledge layer (OKF-aligned)          │
│   Ledger layer (events · provenance ·    │
│   claims/leases · CAS integrity)         │
├─────────────────────────────────────────┤
│          Transport Protocol              │
│   MCP (one reference integration)        │
│            — swappable —                 │
└─────────────────────────────────────────┘
```

The **knowledge layer** (markdown + YAML frontmatter notes) is aligned with the Open Knowledge Format; see `OKF-Compatibility.md`. The **ledger layer** (`.gcl/`) is GCL's own contribution and the focus of this spec.

## Positioning — complement, don't compete

GCL sits beside two established standards and competes with neither:

- **A2A** (Agent2Agent) is how agents communicate, discover capabilities, and delegate tasks. GCL does not move messages; it records the *provenance* of what was coordinated.
- **OKF** (Open Knowledge Format) is how portable knowledge is packaged. GCL's knowledge layer is OKF-shaped; the ledger is what OKF doesn't cover.

In one line: *A2A is how agents talk; OKF is what they read; GCL is the inspectable record of what they did.* The credible, unclaimed seat is the audit/provenance ledger **over** an A2A + OKF stack — not another comms protocol and not another knowledge format.

## The decision lens — one gate, two levers

Every design decision must **clear the gate first**, then **maximize two levers**, traded deliberately against each other.

### GATE — Safety / oversight (a binary floor, not a security *level*)

A pass/fail design discipline. A decision fails the gate — no matter how much efficiency or cooperation it buys — if it breaks any of these invariants:

- **Provenance present, declared-vs-derived honest** — never fabricate certainty.
- **Never a bypass** of safety, approvals, or provider terms.
- **The trail stays auditable** — no silent or unrecorded action.
- **The human can always oversee** — the outside anchor.
- **Default-private, explicit grants** — least exposure.

The floor names a *design discipline*, not a finished security product. Enforcement is staged and stated honestly per workspace (some pieces server-enforced, some advisory, some planned). Above the floor, how *strong* security is (e.g. signed writes vs connector-stamped tiers) is best-effort and weighted against the levers as the implementation matures.

**Honest claim:** *coordination you can audit, where bad behavior is detectable and expensive* — not *"AI made safe."*

### LEVER 1 — Token efficiency (the adoption gate)
The runtime does the bookkeeping: precompute on write, serve cheap, deltas not full reads, minimal swappable surfaces. *Tokens saved is the trust metric.*

### LEVER 2 — Frictionless cooperation (agents as colleagues)
Wake up oriented; know what's addressed to you; own work without collision; hand off cross-vendor with zero context loss. Frictionless *within* a boundary; deliberate, scoped crossing *between* boundaries.

## Invariants — break these and it isn't GCL

- **Open and uncapturable** — community-owned; a proprietary standard is a walled garden, not a standard.
- **A truth-*trail*, not a truth-*oracle*** — records who/what/when/with-what-standing; never asserts truth.
- **Transport-, vendor-, and founder-independent** — survives MCP, any vendor, and its own creator.
- **Human-anchored** — an AI system coordinating AI needs a non-AI reference point.
- **A portable unit** — the workspace is self-describing and movable; reference across boundaries, never mirror.
- **Declared vs. derived, always distinct** — provenance is first-class; never fabricate certainty.
- **Append-only history** — corrections are new records; history is never rewritten.
- **Per-actor coordination identity** — events, presence, claims, and "what's addressed to me" key on a distinct actor id per interface; family grouping is display metadata only and never collapses coordination state.

## External systems — reference, never mirror

GCL records *that* an external system was acted on and with what standing — it does not ingest and re-host that system's data. Example: GCL references `TICKET-123` and records "Agent X was assigned this, had context Y, changed approach because review Z found a gap." It never becomes the store of record for the external system.

## The method, kept honest

GCL is built by AI, inside the system, governed by the half-built version while building it — so the failure modes surface as the first real subjects — with a human outside the loop as the anchor that keeps multiple agreeable models from agreeing each other into a confident, wrong consensus.

---
*Clear the gate first; then maximize the levers. Can't clear the gate → wrong decision. A lever driven to zero → design smell, look again.*
