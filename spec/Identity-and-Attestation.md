---
gcl_version: 0.1.0
file_type: spec
title: Identity & Attestation
status: active
written_by: claude-cowork
written_at: 2026-06-30
last_updated: 2026-06-30
authoritative: true
ratified_by: [codex, claude-code]
ratified_at: 2026-06-30
tags: [identity, attestation, session-token, verification, prerequisite, protocol]
---

# Identity & Attestation

> **Status: Active — ratified.** The schema/protocol shape is ratified (review GREEN, with the `Schema.md` back-references + the `onboarding-status` file_type added), and §5's attestable ceiling is confirmed against a live reference connector. This is the prerequisite that turns the hierarchy's *advisory* enforcement (`spec/Authority-and-Hierarchy.md`) into *machine* enforcement. This spec is the normative contract (the token, the tiers, the access gate); the runtime MECHANISM is a build track, not built here — see §10.

## 1. The problem
Provenance without verified identity is meaningless: any agent can currently claim any actor id (self-declaration is the weak link — the actor-collapse problem). Authority-bearing actions — issuing a grant, closing a human-gated task, committing to the ledger — must bind to a **verified** identity, not a declared one.

**The hard constraint (load-bearing):** a shared vendor connector can present the **same** transport identity for several distinct interfaces (e.g. a web app, a CLI, and a coordination surface) — interface is **not** derivable from the transport for such vendor-hosted surfaces. So "attest the interface" cannot come from the token for those surfaces. This spec formalizes that ceiling honestly rather than pretending the transport can do more than it can (the honest-declaration-tiered decision).

## 2. Governing law (locked)
Identity must be handled at the **protocol** level and be **transport-agnostic**. The ledger trusts a **normalized token**, never a raw transport handshake and never an agent's self-declaration.

## 3. The normalized session token (`GclSessionToken`)
Issued at workspace-connection time, consumed by the ledger. Maps onto the existing three attribution axes plus auditable metadata:

```yaml
GclSessionToken:
  # the three identity axes
  principal: owner             # verified human/workspace principal — the authority-bearing axis
  mediated_by: mcp-connector   # attested mediator/runtime surface — from owner-controlled server config + token validation, NOT agent text
  actor_identity: claude-web   # declared coordination surface — validated against permitted actors; NOT cryptographically derived under a shared connector
  # tier + provenance metadata
  attestation_tier: principal_attested   # see §4
  transport: mcp-oauth          # which adapter issued this (§6)
  adapter_id: vendor-connector-v1
  derivation_method: owner-config+oauth-validate   # how each claim was obtained (auditability)
  issuer: https://gcl.example.com
  audience: ws_...              # workspace this token is good for
  issued_at: <ISO 8601>
  expires_at: <ISO 8601>
```

`principal` and `mediated_by` are unforgeable (server/token-derived). `actor_identity` is declared-and-validated, and its trust is bounded by `attestation_tier`.

## 4. Attestation tiers (first-class)
Not prose — a declared enum the ledger reads:
- **`unverified`** — best-effort actor attribution only; **no ledger-canonical authority**. Contribution is visible + timestamped but not authoritative.
- **`principal_attested`** — principal verified + mediator server-attested; actor surface remains declared/validated. **This is today's shared-connector reality.** Sufficient to act as the verified principal; the *surface* is trusted by declaration, not crypto.
- **`surface_attested`** — principal + mediator + per-surface actor identity are credential-bound (cryptographically distinguishable). Requires separate per-surface credentials (the per-instance connector model) or an equivalent transport signal.

The tier is recorded on authority-bearing writes so the trail shows *how strongly* each actor was known when it acted.

## 5. The attestable ceiling (build-confirmed)
For a **shared vendor connector**, the maximum honestly attainable is **`principal_attested`**. Confirmed against a live reference connector's handler:
- `principal` — authoritative but **server-env + human-gated** (an owner-configured server-env principal, behind the human `/authorize` step; the caller cannot assert it — fail-closed if it is missing). Not a token-carried crypto claim.
- `mediated_by` — authoritative/unforgeable (owner-configured mediator surface).
- `actor_identity` — **declared + allowlist-validated only** (against an owner-configured permitted-actors set). Allowlist membership is authorization-against-a-set, **not attestation**; structurally un-attestable on this transport.

**Why DCR does not lift the ceiling (the airtight nuance):** an OAuth 2.1 router (`/authorize`, `/token`, `/register` DCR + PKCE-S256) authenticates the **session/principal** and binds the **mediator** — both owner-controlled — and carries nothing that distinguishes the interface. DCR `/register` issues a `client_id`, but under a shared vendor connector all surfaces ride **one registration → one `client_id` → indistinguishable**. Therefore **`surface_attested` requires a DISTINCT per-surface OAuth client (its own `client_id` + token audience) or an equivalent transport credential** — the per-surface-credential upgrade path. Nothing in the current shared handshake substitutes for it.

## 6. Attestation adapters (transport-agnostic shape)
The protocol defines the normalized `GclSessionToken` and conformance requirements. Each transport has an **attestation adapter** (MCP-OAuth, stdio, HTTP, gRPC, message queue, future hosted connectors). Each adapter MUST disclose, per claim, whether it is **derived** (cryptographic/token), **owner-configured** (server env), **declared** (caller-asserted, validated), or **unavailable**. The ledger consumes only normalized claims + tier — never raw MCP-specific handshakes. This keeps identity from anchoring to MCP details that would break stdio/gRPC/etc.

## 7. The access gate (two-tier, composed)
Access is not one check; it's a composition:

```
permit(action) =
    valid GclSessionToken
  AND sufficient attestation_tier for the action
  AND grant/authority scope (spec/Authority-and-Hierarchy.md)
  AND task/capability constraints (capabilities[], task.requires)
  AND HEAD/reconciliation rules
```

Two tiers as the coarse split:
- **Unverified actors** → may **read** + **append to a non-authority-bearing contribution/event lane** only (best-effort attribution; NOT ledger-canonical; NOT arbitrary append to every coordination surface). PR analogy: anyone can open a PR; it's logged, but it isn't merged.
- **Verified actors** (≥ `principal_attested`) → may **commit** — *and still* must pass grant/authority + capability + HEAD checks. Verification is necessary, not sufficient.

Losing provenance on outside contributions is worse than restricting them, so unverified contributions are still recorded — just walled to the contribution lane with no upward inheritance (ties to the Authority-and-Hierarchy outsider grant).

## 8. Binding into the hierarchy
Authority-and-Hierarchy §3 "**Who** — verified actor" resolves precisely to: **"a verified session/principal acting through an actor identity at a stated attestation tier."** This preserves the Drive permission model while keeping the three things distinct: verified **owner** (principal), attested **mediator** (mediated_by), declared **surface** (actor_identity). The **human-authorization token** for human-gated task closure (Task-Lifecycle) is a `GclSessionToken` with a verified human `principal` at tier ≥ `principal_attested`.

## 9. Schema placement
Full semantics live here. `spec/Schema.md` now back-references: (a) the `identity-session` token record shape, and (b) the `onboarding-status` `file_type` contract for `.gcl/agents/<actor>/onboarding-status.yml` (required `status` + `contract_accepted` gate fields + clearer error UX — closes a review-identified gap). Protocol logic stays out of the file contract.

## 10. Design vs build (the honest boundary)
**Agreed + ratified design (this spec):** the token, the tiers, the adapter abstraction, the access-gate composition. **NOT built:** the runtime that issues/validates tokens and enforces the gate. Until that lands, enforcement stays advisory (as today), but the structure, tier vocabulary, and provenance trail are usable now. No part of this claims interface attestation the shared connector cannot deliver.

## 11. Sequencing / open items
1. ✅ Confirmed §5 against a real MCP/OAuth handshake — the ceiling holds; the DCR nuance is folded in.
2. ✅ Ratified + added the `identity-session` record + `onboarding-status` file_type to Schema.md.
3. Build track: token issuance/validation at connect; the access-gate composition in the server; the contribution lane for unverified actors.
4. Upgrade path: per-surface OAuth client (distinct `client_id` + audience) for any interface that needs `surface_attested`.
5. Downstream unblocked: human-auth token for Task-Lifecycle human-gated closure; machine enforcement of Authority-and-Hierarchy grants.
