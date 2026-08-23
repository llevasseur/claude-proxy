---
type: feature
title: Boat — opt-in body capture with redaction and retention
description: Explicitly opted-in request and response body capture, redacted before persistence, stored apart from sanitized sidecars under retention controls.
tags: [boat, capture, privacy, retention]
timestamp: 2026-08-22
---

# Boat — opt-in body capture with redaction and retention

Provenance: new Boat rung record, named deliberately in the four-rung ladder fixed by
[ADR 0004](../adrs/0004-four-rung-outcome-ladder.md).

Boat adds inspection data without weakening Bike's privacy boundary: bodies are captured only when an operator
explicitly opts in, redacted before a single byte reaches disk, stored away from sanitized sidecars, and deleted on a
configurable schedule. This record covers capture and retention; task 10 will extend Boat with its inspection surfaces.

## Product promise

- Capture is **off by default**. With `CAPTURE_BODIES` unset or false, proxy behavior is byte-identical to Bike/Car:
  no body bytes are buffered for capture and no capture file or directory is ever created.
- Captured bodies live in their own directory (`CAPTURE_DIR`, default `captures` beside the audit directory) with a
  `.capture.json` suffix. Sanitized sidecar v1 is untouched — no new fields — per [ADR 0002](../adrs/0002-sanitized-sidecars.md).
- Redaction runs **before persistence**. Default rules remove authorization headers and schemes, cookies and
  CSRF/session-cookie assignments, API keys (`sk-…`), and credential-shaped JSON fields; operators add patterns via
  `CAPTURE_REDACT_PATTERNS`. Field names stay readable; values become `[redacted]`.
- Each capture envelope shares the sidecar's `recordId`, so an exchange can be joined later without embedding any
  body data in the sanitized record.
- Forwarding stays transparent even when capturing: upstream bytes reach the client verbatim; only persisted copies
  are redacted.
- The server honors its own `CAPTURE_BODIES` flag. A proxy capturing while the server has capture disabled cannot
  corrupt ingest, quarantine counts, or Bike/Car summaries; the server never reads or deletes capture files while
  disabled.
- Retention is enforced by deletion: captures older than `CAPTURE_RETENTION_MS` are removed, then oldest-first
  deletion enforces the `CAPTURE_MAX_BYTES` total-size cap.

## Configuration

| Variable | Read by | Default | Purpose |
|---|---|---|---|
| `CAPTURE_BODIES` | proxy + server | off | Shared explicit opt-in for body capture. |
| `CAPTURE_DIR` | proxy + server | `captures` beside `AUDIT_DIR` | Capture storage directory. |
| `CAPTURE_REDACT_PATTERNS` | proxy | empty | Comma-separated additional regex sources, applied case-insensitively. |
| `CAPTURE_RETENTION_MS` | server | 604800000 (7 days) | Age at which a capture file is deleted. |
| `CAPTURE_MAX_BYTES` | server | 268435456 (256 MiB) | Total size cap across capture files. |

## Maintenance

Retention runs periodically inside a started server and headlessly through a documented command:

```sh
pnpm --filter @ox-alpha-proxy/server maintain
```

The command prints one JSON result line (`examined`, `deletedExpired`, `deletedOverCap`, `remainingFiles`,
`remainingBytes`) and exits. Retention semantics are specified in [Capture storage and retention](../specs/capture-retention.md).

Bike and Car remain fully useful with zero inspection data present; nothing in this rung feeds the Overview,
history, or trends surfaces.
