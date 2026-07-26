# Changelog

All notable changes to Guided Context Ledger are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because GCL is pre-1.0 alpha software, its interfaces may change between minor
releases.

## [Unreleased]

### Added

- **Human-readable projections (P0-1) — `@guided-context-ledger/core` 0.1.1.** Every
  `EventLog.append()` now regenerates a durable, human-readable `_readable/<thread>.md`
  projection beside the machine event log, plus a `_readable/INDEX.md` front door
  (per-thread event counts, last activity, latest event). The append-only
  `events/*.jsonl` log remains the sole source of truth; every projection header
  says so and points back to it. `renderAllReadable()` backfills existing threads
  in one pass (the post-deploy migration step). Projection rendering is pure
  (`renderThreadMarkdown` / `renderIndexMarkdown` / `indexRowFromEvents`, all
  exported), file writes are atomic (temp + rename), renders are **serialized by a
  cross-process projection lock** (separate from the event lock, re-reading the log
  inside it) so a concurrent render can never leave a stale projection behind the
  log, and a projection failure can never fail a real append. Ported from the
  private deployment where it ran live for 10 days (deployed 2026-07-08). This
  closes the gap where the published core claimed inspectability but a human needed
  an agent to read the coordination layer.
- **Tolerant-read provenance fields on `AgentEvent`** (`principal`, `mediated_by`,
  `resolves`) — optional, additive. Hosted/mediated deployments already write
  these attribution axes into event logs; the core reader now surfaces them (and
  the projection renders them: `by <principal> · via <mediator>`, `✓ closes:`)
  instead of dropping them. The local append path does not emit them yet; absent
  keys parse to `null`/`[]` exactly as before.
- **New spec: `spec/Readable-Projections.md`** — the human-readable projection
  requirement as a normative gate (machine truth below, readable projection
  beside; acceptance criteria included).

- **Note-write attribution — `@guided-context-ledger/core`.** The note-write
  analogue of the event/ledger action-provenance stamp. A note written through a
  mediated (connector) session now carries who authored it and for whom on two
  surfaces: a current-state `provenance:` block in the note's frontmatter, and an
  append-only note-write record (`.gcl/note-writes.jsonl`) that is authoritative
  for mutation history so "corrections are new records, never edits" holds for
  notes. Sparse and back-compatible: a direct/local write with no axes is
  byte-identical to an unstamped write, legacy notes are never backfilled, and
  absent axes are omitted (never `null`). Each record carries the `sha256` of the
  bytes written. New exports: `stampNoteProvenance`, `hasProvenanceAxes`,
  `buildNoteWriteRecord`, `appendNoteWriteRecord`, `readNoteWriteRecords`,
  `noteWritesPath`, `digestContent`, plus `resolveLedgerDir` (the standard `.gcl`
  ledger-directory resolver). Ported from the private deployment.
- **New spec: `spec/Note-Provenance.md`** — mediated note-write attribution as a
  normative gate (identity axes, sparse/back-compat rules, authoritative
  append-only record; acceptance criteria included).

- **Spec — workspace creation documented as a first-class protocol operation.**
  `spec/Authority-and-Hierarchy.md` gains §8 describing owner-gated workspace
  creation through the protocol itself: a `genesis → init` ledger boundary plus a
  hash-chained Root birth record and live registration (no out-of-band
  provisioning or restart), the creation-vs-selection separation, and the
  delete/death-certificate boundary.

- **Spec sync — five ratified specifications published to `spec/`.** Synced from
  the private development workspace with a redaction pass (live hosts and ids,
  internal implementation paths, and workspace-internal references removed;
  personal and product-name context generalized):
  - `spec/GCL-Protocol.md` — temporal anchoring (ledger time is an operand, never
    the clock; `server_now`/`clock_source` on arrival surfaces) plus the
    "time is anchored, never inferred" invariant.
  - `spec/Identity-and-Attestation.md` (new) — the normalized `GclSessionToken`,
    attestation tiers, and the honest shared-connector ceiling.
  - `spec/Task-Lifecycle.md` (new) — work/contract/outcome completion states, the
    assumption + complexity gates, closure types, and the `task_verification` lane.
  - `spec/Authority-and-Hierarchy.md` (new) — the four-level hierarchy, the
    Drive-style permission/grant model, and the verified-actor seam.
  - `spec/Schema.md` — manifest identity block, capability tokens, note-write
    attribution, cross-workspace `cross_ref`, identity-session and
    onboarding-status records, and the `principal_source` provenance axis.

## [0.1.0-alpha] - 2026-07-04

> **Correction (2026-07-04).** An earlier draft of this entry was dated
> `2026-06-19` and its links pointed at a release tag that was never cut — a
> "phantom release" on a provenance project. GCL's ethos is append-only:
> corrections are new records, never silent rewrites. So this entry is corrected,
> not erased — it now reflects the **real, first tagged** `v0.1.0-alpha`, cut from
> the current verified state on 2026-07-04. The original content is preserved
> below and extended with what actually shipped by tag time.

### Added

- Initial Guided Context Ledger protocol specification and starter workspace.
- Append-only, hash-linked provenance model with actor, revision, and handoff
  conventions.
- `@guided-context-ledger/core`, the reference runtime for ledger operations.
- `@guided-context-ledger/connector`, a local connector implementing the guided
  orient, commit, sync, and handoff loop.
- Unified actor registry, actor profiles, and prescriptive first-run guidance.
- Public onboarding documentation, examples, templates, and workspace setup.
- Contribution, security, conduct, issue-reporting, and pull-request guidance.
- `GOVERNANCE.md`, `ROADMAP.md`, and continuous integration (test + build matrix
  with scaffold-sanity checks).
- npm publish preparation for both packages (files allowlist, public access,
  build+test prepublish guard, per-package LICENSE + README).

Further ratified protocol specifications (Identity-and-Attestation,
Task-Lifecycle, Authority-and-Hierarchy, Context-Model, and temporal-anchoring)
are synced from the development ledger in a follow-up release — see `ROADMAP.md`.

### Security

- Documented GCL's security boundary and private vulnerability reporting path.

[Unreleased]: https://github.com/guided-context-ledger/guided-context-ledger/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/guided-context-ledger/guided-context-ledger/releases/tag/v0.1.0-alpha
