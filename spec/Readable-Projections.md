# Readable Projections — the human-inspectability gate

**Status:** normative. Ratified through multi-agent design review on GCL's own development ledger
(2026-07-06 → 2026-07-08); implemented in `@guided-context-ledger/core` 0.1.1; verified live on the
reference deployment before publication.

## The requirement

Every coordination thread MUST have a durable, human-readable projection generated beside its
machine event log:

- the append-only event log (`events/<thread>.jsonl`) is the **source of truth** — always;
- a generated `_readable/<thread>.md` renders that log as prose a human can read directly;
- a generated `_readable/INDEX.md` lists every thread (event count, last activity, latest event)
  as the human's front door to the coordination layer.

**Machine truth below, readable projection beside it.** A substrate whose honest claim is
"coordination you can audit" fails that claim if auditing requires an agent to summarize raw JSON.
A human — the workspace owner, a reviewer, a future maintainer — must be able to inspect state,
decisions, open loops, task truth, handoffs, provenance, and sequencing with no agent in the loop.

## Normative properties

1. **Always current.** Every successful append regenerates the thread's projection and the index
   before the append call returns. A reader never sees a projection more than one append stale.
2. **Backfill.** An implementation MUST provide a one-pass backfill (`renderAllReadable` in the
   reference implementation) so existing threads project without waiting for new events — run it
   at process/server start and after migrations. Projections must be present in every workspace,
   including downloaded/offline copies.
3. **Refs to truth.** Every generated file MUST declare itself a generated view ("do not edit"),
   name its authoritative source (`events/<thread>.jsonl`), and state when it regenerates. The
   projection never becomes a write surface.
4. **Never blocks truth.** Projection rendering happens outside the append write lock, and a
   projection failure MUST NOT fail the append. The event log commits first; the view is
   best-effort and self-heals on the next append or backfill.
5. **Atomic, serialized writes.** Projection files are written atomically (temp file + rename) so a
   reader never sees a half-written file. Concurrent renders (two processes each re-rendering after
   their own append) MUST additionally be **serialized** — a cross-process projection lock, separate
   from the append lock, under which each render **re-reads the log** — so a slower or older renderer
   can never rename a stale snapshot over a newer one. Atomicity alone prevents a torn file but not a
   stale overwrite; serialization is what makes property (1), "always current," hold under multiple
   processes.
6. **Faithful rendering.** The projection surfaces what the log records where present: actor,
   type, timestamp, causal parent (`re:`), addressing, response obligations, batch-closure
   (`closes:`), task family state with terminal truth folded (first terminal wins), claim/lease
   state, and attribution axes (accountable principal, mediating relay). Fields absent from an
   event render as nothing — the projection never invents.

## Acceptance test (the gate)

A deployment passes when, with no agent mediation:

- a human can open `_readable/INDEX.md` and see every thread with its latest activity;
- opening any `_readable/<thread>.md` shows the full event sequence as readable prose with
  provenance and task/claim state;
- appending one event immediately updates both the thread projection and the index;
- deleting `_readable/` and running the backfill regenerates everything from the logs alone;
- the projection headers unambiguously point back to the machine event log as authoritative.

## Non-goals

The projection is a *view*, not a second truth: it carries no data absent from the log, accepts no
edits, and its loss is harmless. Salience layers (digests, summaries, current-state overlays) are
separate concerns built above the log — this gate only guarantees that raw truth is directly
inspectable by a human.
