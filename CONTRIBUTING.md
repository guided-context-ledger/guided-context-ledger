# Contributing to Guided Context Ledger

Thanks for helping improve GCL. The project is in alpha, so coordination before substantial work is especially valuable.

## Before you start

- Search existing issues before opening a new one.
- Open an issue before substantial protocol, schema, compatibility, or behavioral changes.
- Keep issues and pull requests free of private, personal, secret, or otherwise sensitive information. They are public.

Changes to the stable protocol core require design discussion, a specification update where applicable, tests, and maintainer approval. Additive improvements at the evolving periphery can use a lighter process.

## Development

Use Node.js 18 or newer.

```sh
npm install
npm test
npm run build
```

Please keep changes focused and add or update tests for behavior changes.

## Ledger invariants

The ledger is append-only. Do not rewrite existing ledger history.

Changes affecting provenance, identity, hashing, revisions, or compatibility should include:

- the relevant specification or documentation update;
- tests for the invariant being changed;
- migration or compatibility notes when existing consumers may be affected.

## Pull requests

Explain the problem, the chosen approach, and any compatibility impact. Contributions are integrated through maintainer verification before merge.

By contributing, you agree that your contributions will be licensed under the repository's Apache License 2.0.
