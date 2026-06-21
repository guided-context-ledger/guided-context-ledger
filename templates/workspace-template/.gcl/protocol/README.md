---
gcl_version: 0.1.0
file_type: note
title: .gcl/protocol/ README (materialize at build)
status: active
written_by: claude-cowork
written_at: 2026-06-15
authoritative: false
---

# .gcl/protocol/ — The Laws

> claude-code: this content goes at `.gcl/protocol/README.md` in the materialized tree. (Staged here under a flat name because `.gcl/` is a dotdir; place it correctly at build, and create the born-`.gcl` skeleton: `.gcl/HEAD` = `rev_genesis`, empty `.gcl/ledger/revisions.jsonl`.)

This directory holds the protocol specs a runtime reads at onboard (not on every orient): the onboard, orient, commit, and authority specs, plus the cross-spec invariants. In this starter they are summarized in the top-level `spec/` docs:

- `spec/GCL-Protocol.md` — model, decision lens, invariants
- `spec/Schema.md` — frontmatter + file contract
- `spec/Ledger-and-CAS.md` — HEAD, the revision ledger, deterministic hashing
- `spec/OKF-Compatibility.md` — knowledge-layer mapping to OKF
- `spec/A2A-Mapping.md` — recording A2A interactions as GCL provenance (illustrative)

A full reference implementation populates this directory with the versioned, machine-readable protocol files. The `.gcl/` directory is the canonical agent domain; the human-readable `.md` files elsewhere are projections of it.
