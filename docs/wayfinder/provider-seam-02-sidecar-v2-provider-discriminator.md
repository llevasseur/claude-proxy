# provider-seam-02 — Sidecar v2 with a provider discriminator

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-02-sidecar-v2-provider-discriminator`
**Status:** active

Depends on ticket 01's contract.

## Criteria

1. **Define sidecar v2** carrying an explicit **provider discriminator**, plus `harness`,
   `model` and `adapter_version`. Provider and harness are two separate fields; neither is
   derived from the other ([ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md)).

2. **v1 sidecars remain readable.** This is not a migration of captured files — sidecars
   are the source of truth per the repository's standing rule, and
   [ADR 0019](../adrs/0019-sanitized-audit-sidecars.md) governs their shape. A v1 sidecar
   with no discriminator resolves its provider from the adapter that captured it, at read
   time, and is **never rewritten in place**.

3. **Version the payload explicitly.** A reader must be able to tell v1 from v2 without
   guessing from which keys are present.

4. **Keep sidecars sanitized.** Never persist request bodies, response bodies, prompts,
   tool data, credentials, cookies, or arbitrary headers. Standing repository rule, and
   adding a provider field changes nothing about it.

5. **`cost` and `pricing_source` do not go in the sidecar.** They are resolved at read time
   ([ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md)).

6. Round-trip tests: a v2 sidecar survives write-then-read with every field intact; a v1
   sidecar still parses and resolves a provider; a sidecar whose discriminator names an
   unregistered provider is **rejected loudly**, not silently defaulted.

7. `my-command-tools verify` green.
