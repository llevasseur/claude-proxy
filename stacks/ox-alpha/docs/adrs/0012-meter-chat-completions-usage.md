---
type: adr
title: Meter OpenAI-compatible chat/completions usage
description: Widen the observed contract from Responses alone to include a chat/completions usage block, leaving forwarding unchanged.
tags: [architecture, proxy, usage, chat-completions]
timestamp: 2026-08-22
decided-by: /god
ratified: false
wayfinder: ox-alpha-proxy
needs-human: true
---

# Meter OpenAI-compatible chat/completions usage

## Status

Proposed while wiring a real upstream. A human has not ratified this decision.

## Context

[ADR 0001](0001-use-responses-contract.md) defines the observed contract as the
OpenAI Responses API, and the proxy meters exactly two endpoints:
`/v1/responses` and `/backend-api/codex/responses`.

The first non-OpenAI upstream pointed at this proxy does not speak that
contract. opencode's zen provider serves the model `x-preview-f-free` ("Ox
Alpha") from `https://opencode.ai/zen/v1` over **chat/completions**; it does not
serve `/responses` at all. Traffic forwarded correctly and returned real
completions, while the dashboard stayed empty at zero records, because no
observed endpoint matched.

That is a metering gap, not a forwarding one, and it is invisible from the
dashboard: an operator sees a working proxy reporting nothing, which reads
identically to a proxy nobody is using.

## Decision

Treat a JSON `POST` whose path ends in `/chat/completions` as an observed
exchange, alongside the two Responses endpoints, and normalize its usage block
into the same `UsageTotals` the Responses normalizer produces.

- Match chat/completions by **path suffix**, not exact path. A deployment may
  mount it under a prefix — zen serves `/zen/v1/chat/completions` — and that
  prefix is configuration, not contract.
- The five counts map one to one, under older names: `prompt_tokens` → input,
  `completion_tokens` → output, `prompt_tokens_details.cached_tokens` → cached
  input, `completion_tokens_details.reasoning_tokens` → reasoning output, and
  `total_tokens` unchanged. The same invariants apply, so both normalizers share
  one implementation and differ only in field names.

## Consequences

- Usage and cost appear for any OpenAI-compatible upstream, not only Responses ones.
- [ADR 0007](0007-transparent-http-surface.md) is untouched: forwarding stays
  byte-for-byte transparent, and a parse, pricing, or sidecar failure still
  cannot alter bytes already sent. Metering remains strictly optional to it.
- [ADR 0002](0002-sanitized-sidecars.md) is untouched: the usage block is
  metrics, and the surrounding body — prompts, tool calls, message content — is
  still never persisted.
- **A streamed chat/completions response is metered only when the client asks
  for usage.** The stream carries no terminal named event, so usage arrives on a
  late chunk that OpenAI-compatible servers emit only when the request sets
  `stream_options.include_usage`. Without it there is no usage anywhere in the
  response, and the exchange records nothing rather than recording a guess. The
  last chunk carrying a usage block wins.
- An unknown model still prices as unavailable per
  [ADR 0003](0003-unavailable-incomplete-cost.md); metering a request is not the
  same as being able to price it.
