---
type: feature
title: Session map
description: A page that embeds every session transcript, reduces it to two dimensions with t-SNE, and plots each session as a dot coloured by the slash command that ran it — so subject clusters and command clusters can be compared by eye.
tags: [dashboard, frontend, sessions, embedding]
timestamp: 2026-08-06
---

# Session map

## Summary

A **Session map** page (`/sessions/map`) in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md)
that turns each session transcript into an embedding vector, reduces the whole corpus to two
dimensions with t-SNE, and plots one dot per session. **Position is the entire claim**: two dots
near each other are two sessions about the same subject. Dots are coloured and labelled by the
slash command that ran the session (`/task`, `/god`, `/improve`, `/teach`, …), and a hover tooltip
names the session, its command, and the terms that pinned it where it is.

There are deliberately **no edges**. This is not a graph.

## Motivation

The [Sessions](session-transcripts.md) list is chronological and the
[live session graph](live-session-graph.md) is structural — it draws the one real relation between
transcripts, a parent and the subagents it spawned. Neither answers a question about *subject*:
which sessions were about the same thing, what this install actually spends its runs on, and
whether a given command is applied to one narrow kind of work or across everything. That question
is not about links between sessions at all, which is why it wants a projection rather than a graph:
the only relation is similarity, similarity is continuous, and a layout in which distance *is* the
similarity says it directly. Drawing edges over the top would assert a discrete relation that the
data does not contain.

## Behavior

- **Text per session** (`sessionSubjectText`, `packages/core/src/embedding.ts`) — the transcript's
  title, derived title, opening criteria, and its ordered step text, capped at 20 000 characters so
  one long run cannot dominate the vocabulary. Tool signatures are included rather than stripped:
  `Edit(file_path=src/panel.tsx)` contributes the path's words, and which files a session touched
  turns out to be a strong subject signal.
- **The command envelope is stripped before embedding, and that is the load-bearing choice.** A
  slash-command session's opening prompt inlines the *whole command definition* after the
  `<command-args>` block — thousands of bytes identical across every run of that command.
  Embedding it would cluster `/task` runs with `/task` runs by boilerplate, as a matter of
  arithmetic, and since the dots are coloured by command the map would then only ever prove its own
  colouring. `parseCommandEnvelope` (already in core, for the
  [commands](commands-eval.md) pages) separates a run's criteria from its definition, so the
  criteria is what gets embedded and the command name is kept aside purely as the label. Whether
  same-command runs cluster is then an observation the map can make rather than one it assumes, and
  it is pinned by tests on both sides of the package boundary — the three `/task` runs in each
  fixture span both subjects and must land in *different* clusters.
- **Vectors are TF-IDF** (`buildTfIdf`) — sublinear term frequency (`1 + ln tf`) so a word repeated
  forty times in a long run does not outweigh forty distinct words, smoothed inverse document
  frequency (`ln(1 + N/df)`), and L2 normalization, which makes a dot product the cosine
  similarity. Terms are filtered by document frequency at both ends: below 2 documents a term
  cannot bring two sessions together, and above 50% of documents it cannot separate them. **That
  ceiling is what removes this corpus's own boilerplate** — the repo's paths, the tool names, the
  words every transcript carries — without a hand-maintained stop list that would go stale; the
  literal stop-word list is only English function words. The vocabulary is capped at 4 000 terms,
  rarest first.
- **Why TF-IDF rather than a sentence encoder** — `@claude-proxy/core` has no runtime dependencies
  and no network, and the projection has to be reproducible offline from transcripts already on
  disk. Term overlap is a blunter notion of "same subject" than an embedding model would give; see
  the open questions.
- **Reduction is t-SNE** (`tsne`), run over the full O(n²) gradient rather than a Barnes-Hut
  approximation — well within budget at this corpus size and exactly reproducible. Per-point
  gaussian bandwidths are found by bisection on `beta = 1/2σ²` against a target perplexity, then
  symmetrized into the joint distribution P; the optimizer is the standard one (early exaggeration
  ×4 for 150 iterations, momentum 0.5 → 0.8, per-parameter gains) for 600 iterations from a seeded
  mulberry32 gaussian. Output is centered and scaled so the widest axis spans `[-1, 1]`.
- **Two numerical defects were found by testing the layout rather than by reading it**, and both
  are pinned:
  - **A row whose target perplexity is unreachable was falling back to *uniform*.** Where a point's
    `k` nearest neighbours sit at identical distances, the narrowest possible kernel still spreads
    over all `k`, so entropy bottoms out at `log k` and a perplexity below that can never be
    satisfied. `beta` then climbed until `exp(-d·beta)` underflowed to zero for every neighbour —
    and the underflow branch read that as "still too wide" and widened the search *further*,
    ending at a uniform row. Uniform is the one answer that destroys the structure outright, since
    it declares every other session an equally good neighbour: the map came out scrambled at
    **every** learning rate, which is what made it look like a tuning problem rather than a bug.
    Underflow now lowers the ceiling instead (it proves `beta` is too *large*), and each step's row
    is scored against the target with the **best-scoring row kept** rather than the last one tried,
    so an unreachable target degrades to "concentrated on the nearest neighbours" — which is the
    correct limit — instead of to noise.
  - **A fixed learning rate of 200 diverged.** The gradient sums over every pair, so a rate is not
    scale-free: 200 converged at 6 points and diverged at 60, reaching a correct layout by
    iteration 150 and then oscillating apart by 400. `autoLearningRate` adopts scikit-learn's
    `learning_rate="auto"` rule, `max(n / exaggeration / 4, 50)`, which is 50 across this repo's
    whole plausible corpus size; a caller may still override it.
- **Perplexity is clamped against the corpus** (`clampPerplexity`, the conventional
  `3 × perplexity < n` bound), so an out-of-range request degrades rather than erroring, and the
  response reports the perplexity actually used rather than the one asked for.
- **A session with no usable text is skipped, not placed** — a header-only transcript the proxy
  opened and never appended to has no subject, and parking it at the origin would invent a claim
  about it *and* pull real clusters toward the middle. `meta.skipped` reports how many, and the page
  says so in words.
- **The page** — four stat tiles (sessions placed, distinct commands, vocabulary size, skipped),
  then a legend of command chips each showing its session count, then the scatter. The axes' ticks
  are **hidden deliberately**: they are projection coordinates with no unit, and a number there
  would invite reading a quantity off a position that has none. Dot size is fixed for the same
  reason — nothing here encodes magnitude. Clicking a legend chip hides or shows that command's
  dots, which is how you check whether a cluster is one command or several; a hidden chip keeps its
  place and colour so the legend never reflows. Hovering a dot names the session, its command, its
  model, its top terms, and its task/tool/error counts; clicking one opens that transcript.
- **Colour** — the theme's own signal palette first, then further hues chosen to stay
  distinguishable on the dark surface, wrapping if a map carries more commands than the palette has
  entries (the tooltip disambiguates). An ordinary session — the *absence* of a command — takes the
  faint tone rather than a hue, since it is not one of the commands.
- **Reading it honestly** — t-SNE preserves *local* structure: which dots are neighbours is
  reliable, while the width of the gaps between far-apart clusters is not, and cluster sizes carry
  no meaning. The page states this on the card rather than leaving it to be misread.

The data path is `packages/core/src/embedding.ts` → `server` → `apps/admin`: core does all of the
work and is pure, seeded and dependency-free; the server's `buildSessionEmbedding` only picks the
window and names where the transcripts came from, asking its read source for the same
`listSessionGraphs` the live graph uses — the SQLite substrate by default, the transcript scan when
`DB_READS=0` — and serves `GET /api/sessions/embedding` as `{ points, commands, meta }`. The window
is the **newest 400** transcripts (`SESSION_EMBEDDING_LIMIT`), a real bound rather than a
formality: the layout is O(n²) in time and memory, measured at ~570 ms for 344 sessions. `?limit=`
narrows it and `?perplexity=` overrides the target, both advisory — a non-numeric or out-of-range
value falls back rather than erroring, so the map always renders. `meta.total` always reports the
whole corpus, so a narrowed window still says how much it hid. The route joins the
[parity](retention-lifecycle.md) registry, which is meaningful precisely because the projection is
deterministic: any difference in the points is a difference in the transcripts behind them.

## Acceptance criteria

- [x] `/sessions/map` plots one dot per session transcript, positioned by subject similarity, with
      no edges and no force simulation.
- [x] Dots are coloured and labelled by the slash command that ran the session, with an ordinary
      session distinguished from every command rather than dropped.
- [x] A hover tooltip names the session and its command, plus its model, top terms and step counts.
- [x] Clicking a dot opens that session's transcript; clicking a legend chip hides or shows that
      command's dots.
- [x] The command's inlined definition is stripped before embedding, and a test asserts that runs
      of one command land in different clusters when their subjects differ
      (`packages/core/test/embedding.test.ts`, `server/test/session-embedding.test.ts`).
- [x] Two tight subject groups separate: every within-group distance is smaller than every
      cross-group distance, in core and over real transcript files.
- [x] A row whose target perplexity is unreachable because its nearest neighbours are tied keeps
      the nearest-neighbour concentration rather than collapsing to a uniform row, pinned by a
      regression test at 60 points.
- [x] The learning rate scales with the corpus, and the layout converges rather than diverging at
      600 iterations for corpus sizes from 6 to ~344.
- [x] Perplexity is clamped against the corpus size and the response reports the value used.
- [x] A transcript with no usable text is skipped and counted in `meta.skipped`, not placed.
- [x] `GET /api/sessions/embedding` returns points, the ranked command legend, and meta; an empty
      log directory reads as an empty map rather than an error.
- [x] The same transcripts project to the same coordinates on every run.
- [x] The window is bounded regardless of the `limit` asked for, and `meta.total` still reports the
      whole corpus.
- [x] The route is registered in the read-source parity registry.
- [x] The skeleton reserves the plot's height so the panels below do not jump when data lands.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm check` pass.

## Open questions

- **TF-IDF is term overlap, not meaning.** Two sessions about the same problem in different words
  sit further apart than they should, and two about different problems sharing a vocabulary sit
  closer. A sentence encoder would fix it, but core is deliberately dependency-free and offline;
  the honest options are a local model behind the server package (leaving core pure) or accepting
  the blunter metric. Nothing in the UI currently marks a dot as weakly pinned, though the tooltip's
  term list is the raw material for it.
- **A session whose every term is filtered out of the vocabulary keeps an empty vector**, which is
  equidistant from everything, so it is placed by the layout's own dynamics rather than by its
  content — and it is not distinguished on the page from a well-pinned dot. It is a different case
  from the skipped, text-free transcripts, and arguably wants its own marking.
- **The 400-session window is a bound, not a design.** Past it the newest sessions are projected and
  older ones are simply absent, with only the "newest of N" note saying so. A corpus that outgrows
  the window wants either a date filter the user drives, or an approximate (Barnes-Hut) layout —
  which would cost the exact reproducibility the parity registry currently relies on.
- **Whether the map should be stable across loads as the corpus grows.** It is reproducible for a
  *fixed* corpus, but t-SNE has no out-of-sample extension: one new transcript re-lays out
  everything, so a cluster a person had learned the position of moves. Anchoring the layout, or
  storing coordinates and only projecting new sessions into them, is unexplored.
- **Perplexity is fixed at 18 by default** with no control on the page, though the endpoint accepts
  one. Perplexity is the main knob on whether the map shows a few broad regions or many small
  clumps, and it is currently a decision made for the reader.
- **Nothing measures whether the clustering is any good.** The tests assert separation on synthetic
  fixtures with known groups; there is no measurement against the real corpus, so a regression that
  degrades real-world clustering while keeping the fixtures passing would go unnoticed.

## Related

- [Session transcripts](session-transcripts.md) — the flat, chronological list this map is the
  subject-space counterpart to.
- [Live session graph](live-session-graph.md) — the *structural* view, and the reason this page
  draws no edges: parent/subagent is the one real relation between transcripts, and it is drawn
  there.
- [Commands eval](commands-eval.md) — where `parseCommandEnvelope` and the per-command cost views
  live; this page reuses that envelope parsing for its labels.
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard the **Session map** station lives in.
