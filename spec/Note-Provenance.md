# Note Provenance — attribution for mediated note writes

**Status:** normative. Implemented in `@guided-context-ledger/core` 0.1.1; the note-write analogue of
the event/ledger action-provenance stamp (see `Ledger-and-CAS.md` and `Identity-and-Attestation.md`).

## The requirement

The coordination substrate's honest claim is "accountability you can audit." Free-form notes are a
write surface a human or agent can mutate directly. When a note is written through a **mediated
session** — a connector acting for an accountable human — that write MUST carry *who authored it* and
*for whom*, on two surfaces:

1. a **current-state snapshot** in the note's own frontmatter (a nested `provenance:` block), for
   local/human inspection alongside any legacy `written_by`/`written_at`; and
2. an **append-only note-write record** per mutation, which is **authoritative** for mutation history.

The frontmatter snapshot is overwritten in place on each write, so it always shows the *latest*
author. The append-only record is what makes "corrections are new records, never edits" hold for notes
even though the snapshot is destructive.

## Identity axes

A mediated note write MAY declare any of these axes; all are OPTIONAL and independent:

| Axis | Meaning |
|---|---|
| `actor_identity` | Executing surface that authored the write (declared, allowlist-validated). |
| `principal` | Accountable human the session acts for (session-derived). |
| `mediated_by` | The connector channel that relayed the write (server-stamped). |
| `mediation_standing` | Honest standing of `mediated_by` — e.g. `declared` for a hosted connector, never `verified`. |
| `mediation_evidence_kind` | What that standing rests on (e.g. `static_config`). |
| `model` / `family` / `instance` | Declared provenance/grouping/substrate axes — **never** identity or routing keys. |
| `stamped_at` | ISO-8601 stamp time. |

`model`, `family`, and `instance` are **provenance only**. A conforming implementation MUST NOT use
them as coordination, authority, or routing keys (see `Identity-and-Attestation.md`).

## Normative properties

1. **Sparse and back-compatible.** When no axis is supplied — a direct/local write with no mediated
   session — the write MUST be byte-identical to an unstamped write: nothing is stamped into
   frontmatter and no record is appended. A blank/whitespace-only axis counts as absent.
2. **Legacy is never backfilled.** Pre-existing notes without a `provenance:` block MUST NOT be
   rewritten to add one; provenance attaches only to writes that carry axes.
3. **Idempotent snapshot.** Stamping MUST replace an existing top-level `provenance:` block rather
   than duplicate it, and MUST preserve all other frontmatter keys and the note body. A note with no
   frontmatter gains a fresh fence carrying only the provenance block.
4. **Authoritative history.** Each mediated mutation MUST append exactly one record to the workspace's
   append-only note-write log. Records are ordered oldest-first and accumulate; the log is never
   rewritten. A correction is a new record, never an edit to a prior one.
5. **Content digest.** Every record MUST carry the `sha256` (hex) of the bytes written — the full
   content for a `write`, the appended chunk for an `append` — so a reader can verify the recorded
   mutation against the note's current bytes.
6. **Standard location.** The append-only note-write log lives under the standard ledger directory
   (`.gcl/note-writes.jsonl`) as valid JSONL (one record per line, newline-terminated).
7. **Sparse records.** Any absent axis MUST be omitted from the record entirely (not written as
   `null`), so a direct-write record carries only path, operation, timestamp, and digest.

## Acceptance test (the gate)

A deployment passes when:

- a direct/local note write (no axes) produces a note and log byte-identical to an implementation
  without this mechanism — the mediated path adds cost to nobody else;
- a mediated write stamps a `provenance:` block into the note's frontmatter and appends one record;
- re-stamping a note replaces its provenance block (never two) and leaves body + other keys intact;
- the note-write log round-trips oldest-first, is valid JSONL under `.gcl/`, and each record's
  `content_sha256` matches the bytes written;
- absent axes appear nowhere — not in the frontmatter block, not in the record.

## Non-goals

This spec governs *attribution of the write*, not authorization of it: declaring `principal` or
`mediated_by` is a provenance claim, never a grant of authority (authority is explicit, bounded, and
separate — see `Authority-and-Hierarchy.md`). The standing of a mediation claim is recorded honestly
(`declared`, not `verified`) precisely because a hosted connector's relay is asserted, not
cryptographically attested; strengthening that evidence is a separate concern layered above this gate.
