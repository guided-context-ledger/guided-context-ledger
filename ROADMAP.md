# Roadmap

GCL is developed on a private, live deployment before changes are verified and published here — so this repo intentionally trails the working system. This roadmap says honestly where each piece is:

- **published** — in this repo now
- **in-verification** — built and running privately; publishes when verified
- **design-ratified** — spec agreed through multi-agent review; implementation in progress or queued
- **exploring** — active design discussion; no commitment yet

## Near term

| Item | Stage |
| --- | --- |
| npm publish: `@guided-context-ledger/core` + `connector` | published (this repo) |
| Human-readable projections — `_readable/*.md` generated beside every event log on append + backfill (P0-1) | published (this repo, core 0.1.1) |
| `v0.1.0-alpha` tag + GitHub Release | published (this repo) |
| CI (test + build on PRs) | published (this repo) |
| Temporal anchoring — server-supplied `server_now`/`clock_source`; ledger time as operand, never the clock | published (spec, this repo) / in-verification (runtime) |
| Identity & Attestation spec — normalized session token, attestation tiers, honest shared-connector ceiling | published (this repo) |
| Task lifecycle — pool tasks, claims/leases, terminal states, succession lineage | published (spec, this repo) / in-verification (runtime) |
| Curated provenance excerpts from GCL's own development ledger | queued (`examples/provenance-excerpts/`) |
| Current-state / retrieval-at-transitions (P0-2) — orient serves the smallest binding picture (current-state registers, headlines, tier-1 pointer), not historical archaeology | design-ratified; in-verification (live privately) |

## Mid term

| Item | Stage |
| --- | --- |
| Hosted runtime: remote MCP host with OAuth 2.1 (DCR + PKCE), principal binding | in-verification (live privately); on a publication path |
| Multi-tenant workspaces on one host; per-session workspace selection with isolation | in-verification (live privately); on a publication path |
| Server-side enforcement of the access gate (detection → enforcement) | design-ratified, build queued |
| Authority & hierarchy — grants, Drive-style permission levels, human-gated closures | published (this repo) |
| Two-axis identity: model (the mind) as first-class provenance alongside surface (the transport) | proposal under review |

## Longer term

| Item | Stage |
| --- | --- |
| Surface attestation — per-surface credentials lifting the shared-connector ceiling | design-ratified (upgrade path defined) |
| A hosted community workspace ("proving grounds") to coordinate on the protocol itself | exploring |
| Cross-workspace hierarchy and scoped grants | exploring |
| Push/subscription transport (beyond MCP pull) | exploring |
| Presence as a first-class signal (inform / notify / trigger) | exploring |
| Ledger content economy — summary/body split served by default, thread digests | exploring |

Dates are deliberately absent: items ship when verified, and the changelog — not the roadmap — is the record of what actually happened.
