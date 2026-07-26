# Note Provenance — attribution for mediated note writes

**Status:** normative. Implemented in `@guided-context-ledger/core` 0.1.1; the note-write analogue of
the event/ledger action-provenance stamp (see `Ledger-and-CAS.md` and `Identity-and-Attestation.md`).
The record's machine contract is `spec/schemas/note-write-record.schema.json` — that schema, not this
prose, is the authority for field names and types.

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

## The note-write record

Each record is one JSON object on its own line in `.gcl/note-writes.jsonl`. Its normative shape is
`spec/schemas/note-write-record.schema.json`. Required fields:

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Normalized workspace-relative note path (never absolute; no `.`/`..` segment). |
| `operation` | `"write"` \| `"append"` | Which note primitive ran. |
| `written_at` | date-time | ISO-8601 time of the **mutation** (distinct from the frontmatter axis `stamped_at`, which is when the *snapshot* was stamped). |
| `content_sha256` | hex(64) | sha256 of the mutation payload (see property 5). |

Optional identity axes (all sparse, all omitted when absent): `actor_identity`, `principal`,
`mediated_by`, `mediation_standing`, `mediation_evidence_kind`, `model`, `family`, `instance`. New
records SHOULD carry `schema_version` (`"1.0.0"`); a record with no `schema_version` is read as
legacy v1.

`model`, `family`, and `instance` are **provenance only** — a conforming implementation MUST NOT use
them as coordination, authority, or routing keys (see `Identity-and-Attestation.md`).

## Normative properties

1. **Sparse and back-compatible.** When no axis is supplied — a direct/local write with no mediated
   session — the write MUST be byte-identical to an unstamped write: nothing is stamped into
   frontmatter and **no record is appended**. A blank/whitespace-only axis counts as absent.
2. **Legacy is never backfilled.** Pre-existing notes without a `provenance:` block MUST NOT be
   rewritten to add one; provenance attaches only to writes that carry axes.
3. **Idempotent snapshot.** Stamping MUST replace an existing top-level `provenance:` block rather
   than duplicate it, and MUST preserve all other frontmatter keys and the note body. A note with no
   frontmatter gains a fresh fence carrying only the provenance block.
4. **Authoritative history.** Each mediated mutation MUST append exactly one record to
   `.gcl/note-writes.jsonl`. Records are ordered oldest-first and accumulate; the log is never
   rewritten. A correction is a new record, never an edit to a prior one.
5. **Content digest.** Every record MUST carry `content_sha256` — the sha256 (hex) of the *mutation
   payload*: the full written content for a `write`, the appended chunk for an `append`. This lets a
   reader verify the recorded mutation payload when that payload is available. It does **not**, by
   itself, verify a note's *current* bytes after later writes — an append-chunk digest is not the
   digest of the whole note, and a `write` digest only matches the current note while it remains the
   latest write.
6. **Standard location.** The log lives under the standard ledger directory (`.gcl/note-writes.jsonl`)
   as valid JSONL: one JSON object per line, newline-terminated, produced by JSON serialization (never
   string interpolation).
7. **Sparse records.** Any absent axis MUST be omitted from the record entirely (never written as
   `null`), so an **axis-sparse mediated record** carries only the four required fields (`path`,
   `operation`, `written_at`, `content_sha256`) plus whatever axes were supplied.
8. **Tolerant reads / evolution.** A reader MUST ignore or preserve unknown fields and MUST NOT reject
   an otherwise-valid record for an additive optional field. An unknown `operation` or an unsupported
   major `schema_version` MUST be surfaced as uninterpreted — never silently coerced to `write`/`append`.
9. **Mutation/record atomicity + exactly-once (host composition obligation).** A mediated note operation
   MUST NOT report success unless *both* the note mutation and exactly one corresponding authoritative
   record are durable. Three sub-obligations make this real rather than best-effort:
   - **Atomic mutation (no unobserved clobber).** Every note mutation — the initial write AND any
     compensating write/remove — MUST be an atomic compare-and-set: it applies only if the note still
     holds the exact bytes the operation observed (the prior bytes for the initial write; the just-written
     bytes for compensation). A plain read-then-write does NOT satisfy this: a writer landing in that
     window would be clobbered. A CAS failure means a concurrent writer intervened; the operation MUST
     fail-closed and surface the (unrecorded) inconsistency rather than overwrite newer bytes.
   - **Exactly-once via idempotency key, bound to one canonical write.** The record append MUST be
     idempotent, keyed by a stable `operation_id` carried on the record, so a retry of the same logical
     mutation can never produce a duplicate or a second mutation. An `operation_id` is bound to ONE canonical
     `(path, operation, content)`: on any pre-existing / already-present / ambiguous outcome the
     implementation MUST retrieve the durable record and verify it is THIS write. A match is a true replay
     (return the durable record, mutate nothing); a MISMATCH — the same `operation_id` reused for a different
     path or payload — is a collision that MUST fail closed, atomically rolling back this call's mutation so a
     losing writer never returns success with an unrecorded write. A boolean "does a record exist" check is
     insufficient for this — canonical retrieval (or an equivalent fingerprint) is required.
   - **Ambiguous-append recovery.** If the record append fails ambiguously (it may have durably landed
     before throwing), the implementation MUST read back by `operation_id` before compensating: if the
     record is present, the note+record pair is consistent and MUST be kept (rolling back would violate
     exactly-once); only if the record is genuinely absent may the note be atomically rolled back. It MUST
     NOT leave an apparently-successful but unrecorded mutation, nor a note rolled back beneath a durable
     record.
   The reference *primitives* stay composable (`stampNoteProvenance` and `appendNoteWriteRecord` are
   separate calls); this invariant is the composition obligation the host is held to when it wires them
   together. The reference implementation provides `runNoteWriteRecorded` — a strategy-neutral orchestrator
   over an injected note store (atomic `writeIfCurrent` / `removeIfCurrent`) plus an idempotent record sink
   (`appendRecordIdempotent` / `hasRecord`). The storage MECHANISM behind the CAS (O_EXCL create, per-note
   lock, temp-file rename, …) is an implementation concern; the CAS + exactly-once INVARIANT is not.

## Acceptance test (the gate)

A conforming deployment passes each numbered case (mapped to the reference conformance suite in
`packages/core/test/note-provenance.test.ts`):

- **A1** — a direct/local note write (no axes) produces a note and log byte-identical to an
  implementation without this mechanism. *(tests: "no axes → byte-identical"; property 1)*
- **A2** — a mediated write stamps a `provenance:` block into the note's frontmatter. *(tests: "without
  frontmatter gets a fresh fence", "with frontmatter keeps its existing keys"; property 3)*
- **A3** — re-stamping a note replaces its provenance block (never two) and leaves body + other keys
  intact. *(test: "re-stamping REPLACES the provenance block"; property 3)*
- **A4** — a mediated mutation appends exactly one record; the log round-trips oldest-first and is
  valid JSONL under `.gcl/`. *(tests: "append-only round-trip", "log lives under the ledger dir";
  properties 4, 6)*
- **A5** — `content_sha256` equals the sha256 of the mutation payload. *(test: "record carries …
  content digest"; property 5)*
- **A6** — absent axes appear nowhere — not in the frontmatter block, not in the record. *(tests:
  "undefined axes are omitted", "sparse axes dropped"; property 7)*
- **A7** — an injected record-append failure after a note write (for `write`, `append`, and create)
  leaves NO apparently-successful unrecorded mutation: the note is atomically rolled back to its prior
  state (or removed, if it was just created). *(tests: "atomic: record-append failure on a
  WRITE/CREATE/APPEND rolls … back"; property 9)*
- **A8** — a concurrent LATER writer that moves the note *after* our write but *before* compensation is
  NOT clobbered: the atomic `removeIfCurrent`/`writeIfCurrent` refuses and the durable inconsistency is
  surfaced instead. *(test: "atomic: concurrent LATER write during compensation ⇒ atomic CAS refuses
  rollback, newer bytes survive (blocker 1)"; property 9)*
- **A9** — a concurrent writer landing *between* the initial read and the initial write is NOT clobbered:
  `writeIfCurrent` refuses, nothing is recorded, and the fail-closed refusal is surfaced. *(test: "atomic:
  concurrent writer between read and initial write ⇒ writeIfCurrent refuses, no clobber (blocker 2)";
  property 9)*
- **A10** — exactly-once: (a) an append that durably lands then throws is resolved by `operation_id`
  readback — the note is KEPT and exactly one record remains; (b) retrying the same `operation_id` adds no
  duplicate record and does not re-mutate. *(tests: "atomic: append durably lands then throws ⇒ readback
  keeps the note, exactly one record (blocker 3)", "atomic: retrying the same operation_id is idempotent";
  property 9)*
- **A11** — operation_id collision fails closed: (a) the same `operation_id` reused for a DIFFERENT path —
  the second writer's note is rolled back and no second record is written; (b) the same `operation_id`
  replayed with a DIFFERENT payload — refused before any mutation, no freshly-built non-durable record.
  *(tests: "atomic: same operation_id across different paths ⇒ collision fails closed", "atomic: same
  operation_id replayed with a different payload ⇒ collision, refused"; property 9)*

## Non-goals

This spec governs *attribution of the write*, not authorization of it: declaring `principal` or
`mediated_by` is a provenance claim, never a grant of authority (authority is explicit, bounded, and
separate — see `Authority-and-Hierarchy.md`). The standing of a mediation claim is recorded honestly
(`declared`, not `verified`) precisely because a hosted connector's relay is asserted, not
cryptographically attested; strengthening that evidence is a separate concern layered above this gate.
