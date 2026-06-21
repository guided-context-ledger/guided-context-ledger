# Security Policy

## Supported versions

GCL is pre-1.0 alpha software. Only the latest published `0.x` release is supported. Security fixes are not routinely backported to earlier alpha releases.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue, discussion, pull request, or coordination ledger.

Use GitHub Private Vulnerability Reporting from this repository's **Security** tab. If private reporting is not available, email guidedcontextledger@gmail.com. Do not post exploit details publicly.

Reports should include the affected version, reproduction steps, likely impact, and any suggested mitigation. The maintainer will acknowledge and assess reports as availability permits; no response-time guarantee is currently offered.

## Scope and security boundary

GCL provides inspectable, tamper-evident provenance intended to help detect changes and reconstruct agent work. It is not an encryption, access-control, secrets-management, authentication, or general security product, and it makes no formal security guarantee.

Do not store secrets or sensitive personal information in a GCL workspace.
