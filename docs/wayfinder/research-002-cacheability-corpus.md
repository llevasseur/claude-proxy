# Research 002 — Cacheability of real Claude Code traffic

Deliverable for [ticket 002](tickets/002-cacheability-gate.md). Read-only study of
the captured `logs/*.audit.json` + `.request.txt` corpus, characterizing traffic
against the three cacheability gates agreed with the user: **determinism**,
**statelessness**, and **recurrence**.

## Corpus & method

- **Source:** `logs/` in the main checkout (gitignored capture; not in this branch).
  `logs/` is a *live* capture, so counts drift as the proxy runs — the figures below
  are from a single frozen snapshot of **684 audit records**, **663** with a
  non-empty `POST /v1/messages` body.
- **Skim gate population:** the skim only touches *streamed* `/v1/messages`
  (`proxy/skim.mjs:cacheable` requires `stream === true`). That is **446** of the
  663 bodies. The other **217** carry no `stream` flag — Claude Code's
  **token-count preflights** (`count_tokens`), which mirror the real prompt but are
  sent to size it, not to answer it. The gate already excludes them correctly; they
  are not part of any hit-rate.
- **Key replication:** the byte-exact floor is `sha256` over each raw
  `.request.txt` body — the same bytes `keyFor` hashes at request time
  (`proxy.mjs` writes `.request.txt` as `body.toString("utf8")` of the exact hashed
  buffer). Scripts: `$JOB/tmp/analyze*.py` (throwaway, not committed).
- 3 models in the streamed set: `claude-opus-4-8`, `claude-sonnet-5`,
  `claude-haiku-4-5` (opus/sonnet dominate ~50/50).

## Q1 — Byte-exact repeat rate (the exact-match hit-rate floor)

**0.7%.** Of 446 gated requests, only **3** are byte-identical repeats of an
earlier body; **443 distinct** bodies. Just **2** distinct bodies ever recur, one
of them 3×. This is the floor ticket 001 flagged as "hits rarely" — now measured.

Even relaxing "identical body" to "identical conversation **prefix**" (all messages
except the last) lifts recurrence only to **1.8%** (8/446). Byte-exact keying, at
any prefix depth, is effectively dead on real agent traffic.

## Q2 — Shapes that recur but are *not* byte-identical

The recurrence is almost entirely in the **stable scaffold**, not the tail. Over
the same 446 gated requests, hashing only sub-parts of the body:

| Normalized on | Distinct values | Requests that are a repeat |
|---|---:|---:|
| model only | 3 | 99.3% |
| tools array | 20 | 95.5% |
| system prompt | 26 | 94.2% |
| first user message | 29 | 93.5% |
| system + tools | 35 | 92.2% |
| first 2 messages | 51 | 88.6% |
| **full body (byte-exact)** | **443** | **0.7%** |
| all-but-last message (prefix) | 438 | 1.8% |

Reading: the **front** of every request is drawn from a tiny pool (≤35 distinct
system+tools scaffolds), while the **full body** is almost always unique. The
variance lives entirely in the growing message tail — accumulated `tool_result`
turns, appended reminders, and the current user ask. **These are the semantic-layer
candidates**: requests sharing a system+tools+opening-turn scaffold (88–95% do) but
diverging in the tail. A byte-exact key can never catch them; a scoped/semantic key
keyed on the *task* rather than the full transcript could.

## Q3 — Volatile signals the key must exclude or scope on

Nearly every gated body embeds live, non-deterministic context. Presence across the
446 gated bodies:

| Signal | Bodies containing it |
|---|---:|
| `Today's date is …` | 100% |
| absolute cwd paths (`/Users/…`) | 100% |
| git branch / HEAD | 100% |
| `gitStatus` block | 100% |
| `<system-reminder>` blocks | 100% |
| `currentDate` context | 100% |
| `tool_result` / `tool_use` content | 91% |
| bare ISO timestamps | 23% |

Concrete injected strings pulled from a live body: `Today's date is 2026-07-18.`,
`Current branch: main`, `/Users/llevasseur/.claude/CLAUDE.md`. This is *why* the
byte-exact floor is 0.7% and simultaneously *what a naive cache would serve stale*:
two otherwise-identical asks differ because the date rolled, the branch changed, the
git status moved, or a tool returned different bytes.

For ticket 003, the key/invalidation policy must therefore:

- **Exclude from the key** (pure noise for identity): injected date/clock,
  `<system-reminder>` wrappers, absolute cwd paths.
- **Scope the key on** (changes the correct answer, must not be silently dropped):
  git branch/HEAD + working-tree status, and `tool_result` payloads — an answer
  computed against one repo state is wrong to replay against another.
- **Treat `tool_result` content as an invalidation dependency**, not cache text:
  it is both the largest source of tail variance and the strongest staleness risk.

## Takeaways for the map

1. **Byte-exact skim is a near-zero-hit floor (0.7%)** on real Claude Code traffic —
   confirms ticket 001's rough edge with a number, not a hunch.
2. **The recurrence is real but semantic** (≤35 scaffolds cover 92%); it is only
   reachable by a key that ignores the volatile tail — graduating the *Semantic skim
   layer* from *Not yet specified*.
3. **The tail is also the staleness risk.** The same fields that block byte-exact
   hits (git state, tool results, clock) are exactly what an aggressive cache would
   serve stale — so ticket 003's key must scope on repo/tool state while excluding
   pure clock/path noise.
