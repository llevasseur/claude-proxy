# monorepo-fusion-13 — Write the campaign's eleven new decision records

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-13-write-campaign-adrs`
**Status:** done · 2026-08-24

## Goal

Write ADRs 0039–0049 as **records**, not as fresh decisions. Every one of these was
decided before the campaign started. Do not re-decide them, do not grill them, and do
not add a `needs-human` flag to any of them.

Numbering follows ADR 0053: the brief's `0047`–`0051` were computed from the bad count of
46 and shift down by eight. Titles are load-bearing; numbers are not.

## Criteria

**All eleven are `ratified: true` and `scope: all`.**

| # | Title |
|---|---|
| 0039 | Fuse the three proxy repos into one monorepo |
| 0040 | Three providers and three harnesses, paired but not fused |
| 0041 | A site-wide provider picker drives the navigation |
| 0042 | claude-proxy's dashboard is the design baseline, and UI design is delegated to a Fable subagent |
| 0043 | Campaign state lives in the repo, and the wayfinder map is the control plane |
| 0044 | Cost semantics: every model gets a price row |
| 0045 | TanStack Router, repo-wide |
| 0046 | The server accepts narrowly-scoped local writes |
| 0047 | SQLite is the query substrate, with a forward-only migration ladder |
| 0048 | Deletion policy, split by tier |
| 0049 | Capture every body, redact on read and export |

**Content notes that must survive into the records:**

- **0039** supersedes the merged records that codex/ox `0005` (fresh history) and `0006`
  (private publication) became — **not** the originals by their old numbers, which no
  longer identify anything (ADR 0053). It notes that parity-with-a-separate-repo is a
  category error once that repo is a sibling directory.
- **0040 is load-bearing for every ticket in this campaign.** Anthropic/Claude Code,
  OpenAI/Codex and Ox Alpha/opencode are **three distinct pairs**. "codex/ox" names
  shared repo lineage and **nothing else**. No code may infer the harness from the
  provider or the provider from the harness. Two independent columns, two independent
  adapter registries.
- **0041**: picker defaults to Anthropic; only the selected provider streams; the side
  rail renders only the stations that provider supports; switching provider on an
  incompatible page redirects to the Overview; model-agnostic pages such as Ideas and
  Concepts are available under every provider.
- **0044**: neither claude's `FALLBACK_PRICE` nor codex/ox 0003's blanket ban. Each proxy
  declares its own fallback row; records priced by it are stamped
  `pricing_source: fallback:<proxy>`. A model with no defensible rate is `unknown` with
  cost **null, never 0**. Rates are a table with a dashboard CRUD page. **No effective
  dating** — one current rate per model prices every row, and a rate edit reprices the
  corpus.
- **0046** also records: **one database and one controller per proxy, n for n**, so no
  two proxies share a writer and one store going down costs only its own provider's
  pages. And: a mid-stream disconnect is recorded `interrupted` by the **hosting proxy
  alone**, and `resumed` if that same proxy resumes it, with tokens counted so far kept
  and flagged `usage_complete: false`.
- **0047**: claude 0004 wins; codex 0010's rebuild-on-mismatch is **dropped**. The reason
  is evidence rather than preference — `request_skim` is derived **before** body eviction
  and is forward-only, so for days whose bodies are already evicted the database holds
  data no sidecar can reproduce, and a rebuild would silently delete it.
- **0048**: a record, its usage and its cost are **never** deleted, so trends,
  suggestions and the judge keep their full history. **Bodies** age out under ox's age
  and byte cap, routed through the typed `blob_evicted` tombstone that already exists —
  because bodies are the 27 GB and records are the value.
- **0049**: capture every body unconditionally; redact on **read and export** rather than
  at capture. claude-proxy is a local-only observer of the user's own machine and the
  corpus is the product — skim, suggestions, context and the judge all read bodies, and
  an opt-in default produces a half-empty history that cannot be backfilled. Redaction is
  not dropped; it moves to every path that leaves the machine. Bodies still age out
  under 0048.

## Constraints

- **`ratified: true`, and no `needs-human` flag on any of the eleven.** These are the
  human's own decisions, recorded. The four `needs-human` records in this campaign are
  the ones `/dev` wrote (0050, 0052, 0053, 0054) and they already exist.
- Each carries `scope: all` and a `provenance` field naming this campaign.

## Done when

`docs/adrs/0039`–`0049` exist, `okq --bundle docs find --where ratified=true` returns all
eleven, none carries `needs-human`, and `okq --bundle docs validate` is conformant.
