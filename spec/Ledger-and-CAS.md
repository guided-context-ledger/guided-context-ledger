---
gcl_version: 0.1.0
file_type: spec
title: Ledger and CAS
status: active
written_by: claude-cowork
written_at: 2026-06-15
authoritative: true
---

# The Ledger & Content-Addressed Integrity

The ledger layer is what makes GCL auditable and tamper-evident. It has three pieces: **HEAD** (the fast pointer to current truth), **the revision ledger** (append-only history), and **deterministic hashing** (so any compliant runtime, any OS, any vendor recomputes the same ids).

## `.gcl/HEAD`

A single file containing the current canonical revision id and nothing else. A new workspace starts at:

```
rev_genesis
```

Rules:
- `HEAD` changes only at commit finalization, after all staged lanes write and verify.
- Commit uses **compare-and-swap**: the value read during validation is `expected_revision`; finalization may advance `HEAD` only if it still equals `expected_revision`. This makes concurrent commits safe.
- A failed or partial commit must not advance `HEAD`.

## `.gcl/ledger/revisions.jsonl`

Append-only commit history — one JSON object per finalization attempt. Revision ids are **content-addressed, not sequential**, which prevents collisions when two agents finalize from the same parent concurrently.

```
revision_id = "rev_" + first_24_hex(SHA-256(canonical(envelope)))
```

The envelope includes `parent_revision`, `commit_id`, `actor`, `session`, `timestamp`, `schema_version`, `spaces_contract_version`, sorted `artifacts[{path, lane, hash}]`, and sorted `lanes`. It excludes `revision_id` itself and any display-only fields (a `sequence_hint` may exist for humans but is never identity).

Append rules:
- Finalize **ledger-first, HEAD-second, journal-delete-third**. A ledger entry can exist before `HEAD` advances; it is not canonical until `HEAD` reaches its `revision_id`.
- **HEAD reachability is the source of truth.** An entry not reachable from `HEAD` is a recovery candidate, not an authoritative revision.
- The ledger is append-only. Corrections, orphan markings, and recovery outcomes are *new* records — never in-place edits.
- `orient` reconstructs the delta by reading entries after an agent's `last_seen_revision` up to `HEAD`.

Genesis: an empty workspace has `HEAD = rev_genesis` and an empty (or single genesis-record) ledger. `rev_genesis` is a reserved anchor, not derived from an envelope. The first real commit sets `parent_revision: rev_genesis`.

## Deterministic hashing

All hashes must be **byte-for-byte identical across every agent, OS, and sync client**, or integrity checks break silently. Normalization applied before any hash:

1. **Encoding:** UTF-8, no BOM.
2. **Line endings:** CRLF and CR → LF.
3. **Paths:** workspace-relative, POSIX separators, case-sensitive as stored.
4. **Ordering:** lists sorted by path using byte-wise (not locale) comparison.
5. **Algorithm:** SHA-256; ids use the first 24 hex chars unless stated.

### Canonicalization

The envelope is serialized by a **stable stringify**: object keys sorted byte-wise at every depth; arrays left in given order unless they carry no semantics.
- Arrays with no semantics are pre-sorted: `artifacts` by `"<lane>:<path>"`, `lanes` ascending.
- **Order-significant arrays are NOT sorted** — e.g. a relay chain `["cli","desktop"]` ≠ `["desktop","cli"]` and must yield different ids.
- A key whose value is `undefined` is dropped before hashing (so "present but unset" == "absent"); an explicit `null` is preserved as "explicitly none."

### Three hash domains

| Hash | Captures | Changes when |
|---|---|---|
| `revision_id` | a single commit envelope | any committed content/metadata changes |
| `spaces_contract_version` | the content of `spaces/` (the constraints) | a constraint file's content or path changes |
| `workspace_topology_version` | which directories exist (structure, not content) | a branch is added/removed (new agent, new channel) |

`spaces_contract_version` hashes a sorted manifest of `"<path>\t<sha256(content)>"` for every file under `spaces/`. The topology hash hashes the sorted set of structural directory paths only — ephemeral/per-session files are excluded so they never trigger false re-onboards.

### Versioned recipe & migration guarantee

The revision recipe is **keyed on `schema_version`** so it can evolve without rewriting history. Every revision already on disk must recompute byte-for-byte under the recipe version it was written with — the runtime never rewrites history. New schema versions add fields under a new version key; old revisions keep their original recipe. A conformance regression snapshots the live ledger and recomputes all legacy ids to prove this holds.

## Conformance

Any compliant runtime computing any of these hashes from the same workspace state MUST produce the identical value. If two agents disagree on a `revision_id` for the same envelope, that is a determinism bug — not a fork and not contract drift — and surfaces as a top-tier health issue, not a re-onboard.
