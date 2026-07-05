# Provenance Excerpts — GCL Building Itself

This repo ships with a clean, empty ledger — a scaffold for *your* workspace. But GCL is developed **on a live GCL ledger**, and the strongest evidence for the protocol is its own trail. This directory **will hold** curated excerpts: real events, real review gates, real failure modes caught and fixed, with original event ids, seqs, actor ids, and timestamps preserved. The curation rules are published here first — the standard is public before the first excerpt lands; each excerpt is added as the maintainer curates it and the principal approves it (see "Adding an excerpt" below).

## Curation rules (provenance-honest redaction)

1. **Redaction is marked, never silent** — removed content becomes `[REDACTED: <category>]` (personal / infrastructure / credential-adjacent). The trail shows that and why something was removed, never pretending it wasn't there.
2. **No personal information** beyond the principal's chosen public identity; the principal approves every excerpt pre-publication.
3. **No live infrastructure details** — hosts, paths, tokens, shas of unpublished artifacts.
4. **Events whole or truncated with markers** (`[TRUNCATED: n chars]`) — never silently edited.
5. **Every excerpt carries a header**: source thread, seq range, date range, curator, approval date.

## The first excerpts (in preparation)

**01 — Temporal anchoring: catching a silent reasoning bug.** An agent inferred "now" from the newest ledger timestamp and silently corrupted every time-based judgment downstream. The trail shows live catch → root cause → recurrence on an uncovered surface → structural fix (the server supplies the clock). This failure mode exists in every agent system that stores timestamps; most have never noticed.

**02 — The "split-brain" that wasn't.** Two agents from different vendors disagreed on a thread's latest event — an apparent consistency violation. The trail shows the escalation, the wrong hypotheses stated plainly, and the real cause: two valid write layers with different visibility. The ledger records its own false alarms — that's "truth-trail, not truth-oracle" in practice.

**03 — A review gate doing its job.** Cross-vendor adversarial review of a security-adjacent change: the ruling, the guardrails imposed, the build satisfying them, and the reviewer holding deploy-green until source evidence — not assurances — arrived.

**04 — Model succession: recording a change of mind.** The model behind one surface upgraded to a new generation; the trail shows the gap noticed, the profile correction, and the proposal making the model a first-class provenance axis. Agents are replaceable; context is not — including which mind did the work.

## Adding an excerpt

Maintainer-curated only (the source ledger is private). Suggest a theme in a Discussion; if the trail exists and clears the rules above, it gets excerpted with full headers and principal approval. The excerpt files themselves are published as the maintainer curates and the principal approves each one.
