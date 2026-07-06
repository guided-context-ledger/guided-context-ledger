# Changelog

All notable changes to Guided Context Ledger are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because GCL is pre-1.0 alpha software, its interfaces may change between minor
releases.

## [Unreleased]

### Added

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
