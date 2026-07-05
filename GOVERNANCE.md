# Governance

GCL is developed the way it says agent work should be done: **multi-agent review with a human anchor, recorded on an append-only ledger.** This document describes who decides what, and how outside contributions flow in.

## Roles

**Maintainer (human anchor).** The project maintainer holds final merge authority and is the non-AI reference point required by the GCL protocol itself (the "human-anchored" invariant). Today that is the founding maintainer; the goal is a maintainer group as the community grows.

**Agent review team.** GCL is dogfooded by a standing team of AI agents from multiple vendors who design, build, and adversarially review changes on a live GCL ledger before anything ships here. Cross-vendor review is deliberate: it prevents any single model family's blind spots from becoming protocol decisions. Curated excerpts of this process are published in `examples/provenance-excerpts/`.

**Contributors.** Anyone. See the contribution lanes below.

## Contribution lanes (mirrors the protocol's attestation model)

GCL's Identity & Attestation design defines a two-tier access gate: anyone may contribute to a visible, logged lane; merging into the canonical trunk requires verification. GitHub gives us this for free:

- **Open lane** — issues, discussions, and pull requests from anyone. Always welcome, always logged, never silently discarded. A PR is exactly the protocol's "unverified contribution": visible, timestamped, attributed — and not yet canonical.
- **Canonical lane** — merges to `main`. Require CI green plus maintainer verification. Protocol-core changes additionally require the review process below.

## Decision process

**Protocol core** (specs, schema, hashing, ledger semantics, identity/attestation, compatibility): design discussion (issue or Discussion) → spec draft → agent-team adversarial review + ratification on the development ledger → lands here as a spec update with tests. Ratification evidence (event ids, review outcomes) is referenced in the PR description — decisions carry provenance, including our own.

**Evolving periphery** (connector ergonomics, docs, examples, tooling): lighter — issue, PR, CI, maintainer review.

**Disagreements** resolve by discussion first; the maintainer is the tiebreak. Objections are recorded, not deleted — corrections are new records, never rewrites, in governance as in the ledger.

## Release trains (specs and code ship separately)

- **Specs** ship when ratified. Team ratification *is* their verification; a ratified spec that isn't published is treated as overdue.
- **Code** ships when tested: test-green, CI-verified, changelogged, tagged.

Both follow SemVer (pre-1.0: minor bumps may break; see `CHANGELOG.md`).

## What will not change by vote

The GCL invariants (see `spec/GCL-Protocol.md`) are the project's identity, not preferences: open and uncapturable; truth-trail not truth-oracle; transport/vendor/founder independence; human anchoring; append-only history; declared-vs-derived honesty. Proposals that break an invariant are out of scope — fork freedom is what the Apache-2.0 license is for.
