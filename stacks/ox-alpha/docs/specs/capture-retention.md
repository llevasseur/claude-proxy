---
type: spec
title: Capture storage and retention
description: Storage layout, redaction pipeline, envelope schema, and retention semantics for Boat body capture.
tags: [boat, capture, redaction, retention, privacy]
timestamp: 2026-08-22
---

# Capture storage and retention

Boat's capture rung is specified here so the sanitized sidecar contract in
[Bike architecture](bike-architecture.md) and [ADR 0002](../adrs/0002-sanitized-sidecars.md) stays closed. The
feature-facing record lives at [Boat](../features/boat.md).

## Defaults and opt-in

Capture is off everywhere unless `CAPTURE_BODIES` is explicitly true (`1/true/on/yes`, case-insensitive). The proxy
and the server each read this flag; both processes default to `captures` beside `AUDIT_DIR` when `CAPTURE_DIR` is
unset. With capture off, no capture directory is created, no extra bytes are buffered, and proxy behavior is
byte-identical to the pre-Boat surface.

## Storage separation

Capture files are named `<capturedAt>_<recordId>.capture.json` inside `CAPTURE_DIR`, never inside the audit
directory. They are written with the same atomic temp-file-plus-rename mechanics as sidecars (mode 0600). The server's
sidecar ingest matches only `.audit.json`, so a misconfigured proxy pointing its capture directory at the audit
directory cannot corrupt ingest, quarantine counts, or any Bike/Car summary; stray `.capture.json` files there are
ignored outright.

## Redaction pipeline

Redaction runs in the proxy on fully buffered request and response text before any persistence:

1. Default rules (case-insensitive): credential-shaped JSON fields, header-style authorization/cookie lines,
   bearer/basic scheme credentials, `sk-` API keys, and cookie/CSRF/session-cookie assignments.
2. Operator rules from `CAPTURE_REDACT_PATTERNS` (comma-separated regex sources), compiled at startup so an invalid
   pattern fails fast.

Matched values become `[redacted]`; matched field names survive for readability. Forwarding is never redacted — only
persisted copies are.

## Capture envelope v1

The strict validator accepts exactly these fields; unknown fields fail like the sidecar validator:

| Field | Purpose |
|---|---|
| `schemaVersion` | Selects the validator; always `1`. |
| `recordId` | Shared with the exchange's sanitized sidecar for joining. |
| `capturedAt` | ISO UTC timestamp, identical to the sidecar timestamp. |
| `endpoint` | Request pathname only. |
| `requestText` | Redacted request body text (may be empty). |
| `responseText` | Redacted response body text (may be empty). |

## Retention semantics

Retention applies to final `.capture.json` files only; dot-prefixed temporary files are ignored. A running enabled
server maintains captures every reconcile interval, and a headless pass is available through
`pnpm --filter @agent-proxy/ox-server maintain`:

1. **Window:** a file whose age (`now − mtime`) is at least `CAPTURE_RETENTION_MS` is deleted.
2. **Size cap:** survivors sorted oldest-first are deleted until the total size is at most `CAPTURE_MAX_BYTES`.

A disabled server performs no maintenance and reads nothing from the capture directory.
