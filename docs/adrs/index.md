# Architecture Decision Records

Numbered records of significant, hard-to-reverse decisions. The convention itself is
recorded in [0001 — Record architecture decisions](0001-record-architecture-decisions.md):
decisions are append-only, so a reversal is a new ADR that supersedes the old one rather
than an edit. List them:

    okq find --type adr

Add one with `okq new adr "<title>"`.

<!-- okq:index:begin -->
### Concepts

| Title | File |
|-------|------|
| Record architecture decisions | [0001-record-architecture-decisions.md](0001-record-architecture-decisions.md) |
| Monorepo with pnpm, TanStack, and Node | [0002-monorepo-with-pnpm-tanstack-and-node.md](0002-monorepo-with-pnpm-tanstack-and-node.md) |
| Allow narrowly scoped writes in the local server | [0003-allow-narrowly-scoped-writes-in-the-local-server.md](0003-allow-narrowly-scoped-writes-in-the-local-server.md) |
<!-- okq:index:end -->
