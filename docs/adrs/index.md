# Architecture Decision Records

Numbered records of significant, hard-to-reverse decisions. The convention itself is
recorded in [0001 — Record architecture decisions](0001-record-architecture-decisions.md):
decisions are append-only, so a reversal is a new ADR that supersedes the old one rather
than an edit. List them:

    okq find --type adr

Add one with `okq new adr "<title>"`.

## One flat corpus, three sources

`0001`–`0038` are the **inherited** records: the decisions claude-proxy, codex-proxy and
ox-alpha-proxy each made before the `monorepo-fusion` campaign absorbed the three into one
repository. They are numbered by timestamp, and every one carries `scope` — which stack it
governs — and `provenance`, naming the repository, number and path it came from.
**[legacy-map.md](legacy-map.md) resolves every old identifier**, and it is many-to-one:
codex and ox-alpha each recorded eight of the same decisions, and each of those eight is
restated here once, so `codex#0005` and `ox-alpha#0005` both resolve to
[0022](0022-fresh-repository-history.md).

The records above `0038` are this repository's own, written during the campaign and cited
by number from the campaign map and from each other.

**A merged pair is not a supersession.** The rule stated in 0001 — never delete a
superseded ADR — governs *supersession*, which is a relation between a later decision and
an earlier one it replaces. Two repositories writing down the same decision separately is
neither, so that rule is preserved verbatim and simply has no subject here. The originals
persist as git history: both siblings were absorbed with their histories rather than
copied in. The legacy map states this at length, because it is the thing a reader is most
likely to collide.

<!-- okq:index:begin -->
### Concepts

| Title | File |
|-------|------|
| Record architecture decisions | [0001-record-architecture-decisions.md](0001-record-architecture-decisions.md) |
| Monorepo with pnpm, TanStack, and Node | [0002-monorepo-with-pnpm-tanstack-and-node.md](0002-monorepo-with-pnpm-tanstack-and-node.md) |
| Allow narrowly scoped writes in the local server | [0003-allow-narrowly-scoped-writes-in-the-local-server.md](0003-allow-narrowly-scoped-writes-in-the-local-server.md) |
| Adopt SQLite as the query substrate over the log files | [0004-adopt-sqlite-as-the-query-substrate.md](0004-adopt-sqlite-as-the-query-substrate.md) |
| Host the concept store as a Cloudflare Worker over D1 | [0005-host-the-concept-store.md](0005-host-the-concept-store.md) |
| Host the ideas ledger on the existing operator Worker | [0006-host-the-ideas-ledger.md](0006-host-the-ideas-ledger.md) |
| Preserve concurrent note edits with immutable revisions | [0007-preserve-concurrent-note-edits.md](0007-preserve-concurrent-note-edits.md) |
| Archive notes instead of deleting them | [0008-archive-notes-instead-of-deleting.md](0008-archive-notes-instead-of-deleting.md) |
| Autosave notes without losing drafts | [0009-autosave-notes-without-losing-drafts.md](0009-autosave-notes-without-losing-drafts.md) |
| Use Markdown for note content | [0010-use-markdown-for-note-content.md](0010-use-markdown-for-note-content.md) |
| Search notes in the first release | [0011-search-notes-in-the-first-release.md](0011-search-notes-in-the-first-release.md) |
| Keep operator credentials out of the browser | [0012-keep-operator-credentials-out-of-the-browser.md](0012-keep-operator-credentials-out-of-the-browser.md) |
| Preserve note selection during live updates | [0013-preserve-note-selection-during-live-updates.md](0013-preserve-note-selection-during-live-updates.md) |
| Paginate note lists with stable cursors | [0014-paginate-note-lists-with-stable-cursors.md](0014-paginate-note-lists-with-stable-cursors.md) |
| Order notes strictly by recent edit | [0015-order-notes-strictly-by-recent-edit.md](0015-order-notes-strictly-by-recent-edit.md) |
| Return note excerpts from discovery operations | [0016-return-note-excerpts-from-discovery-operations.md](0016-return-note-excerpts-from-discovery-operations.md) |
| Allow blank note titles | [0017-allow-blank-note-titles.md](0017-allow-blank-note-titles.md) |
| Alive view reads server-built node streams | [0018-alive-view-reads-server-built-node-streams.md](0018-alive-view-reads-server-built-node-streams.md) |
| Use the OpenAI Responses contract | [0018-use-responses-contract.md](0018-use-responses-contract.md) |
| Keep audit sidecars sanitized | [0019-sanitized-audit-sidecars.md](0019-sanitized-audit-sidecars.md) |
| Trigger-line age is last-append age | [0019-trigger-line-age-is-last-append-age.md](0019-trigger-line-age-is-last-append-age.md) |
| Stress threshold stays view-local at 30 minutes | [0020-stress-threshold-stays-view-local.md](0020-stress-threshold-stays-view-local.md) |
| Make incomplete cost unavailable | [0020-unavailable-incomplete-cost.md](0020-unavailable-incomplete-cost.md) |
| Fix the outcome ladder, five rungs for codex and four for ox-alpha | [0021-outcome-ladder.md](0021-outcome-ladder.md) |
| SessionsSidenav grows an optional onSelect prop | [0021-sessions-sidenav-optional-on-select.md](0021-sessions-sidenav-optional-on-select.md) |
| Alive view derives from the newest family transcript | [0022-alive-view-derives-from-newest-family-transcript.md](0022-alive-view-derives-from-newest-family-transcript.md) |
| Start with fresh repository history | [0022-fresh-repository-history.md](0022-fresh-repository-history.md) |
| An interrupted last node reads finished | [0023-an-interrupted-last-node-reads-finished.md](0023-an-interrupted-last-node-reads-finished.md) |
| Publish the repository privately | [0023-private-github-publication.md](0023-private-github-publication.md) |
| A toolless error renders its own text | [0024-a-toolless-error-renders-its-own-text.md](0024-a-toolless-error-renders-its-own-text.md) |
| Promise transparent HTTP forwarding | [0024-transparent-http-surface.md](0024-transparent-http-surface.md) |
| Pin Plane parity to one claude-proxy commit | [0025-pin-plane-parity.md](0025-pin-plane-parity.md) |
| The alive view's empty state explains itself | [0025-the-alive-views-empty-state-explains-itself.md](0025-the-alive-views-empty-state-explains-itself.md) |
| Bucket Car trends by report-timezone day | [0026-daily-trend-granularity.md](0026-daily-trend-granularity.md) |
| Stressed renders a bare idle line | [0026-stressed-renders-a-bare-idle-line.md](0026-stressed-renders-a-bare-idle-line.md) |
| Review one campaign at one closing pull request | [0027-one-campaign-review-granularity.md](0027-one-campaign-review-granularity.md) |
| The emotion word is the live region | [0027-the-emotion-word-is-the-live-region.md](0027-the-emotion-word-is-the-live-region.md) |
| Rebuild the view on schema version mismatch | [0028-rebuild-view-on-schema-mismatch.md](0028-rebuild-view-on-schema-mismatch.md) |
| The view toggle lives in the shared shell's header row | [0028-the-view-toggle-lives-in-the-shared-shell-header-row.md](0028-the-view-toggle-lives-in-the-shared-shell-header-row.md) |
| Republish the corpus adapted, not copied | [0029-adapted-corpus-renumbering.md](0029-adapted-corpus-renumbering.md) |
| Express Car ranges as calendar dates on new endpoints | [0030-calendar-date-range-api.md](0030-calendar-date-range-api.md) |
| Certify phase boundaries with automated evidence | [0031-automated-boundary-evidence.md](0031-automated-boundary-evidence.md) |
| Extend SSE with a data-version signal | [0032-sse-data-version-signal.md](0032-sse-data-version-signal.md) |
| Meter OpenAI-compatible chat/completions usage | [0033-meter-chat-completions-usage.md](0033-meter-chat-completions-usage.md) |
| Give history and trends their own routes | [0034-car-dashboard-routes.md](0034-car-dashboard-routes.md) |
| Price Ox Alpha with Claude Fable 5 rates as a stand-in | [0035-fable-standin-rates-for-ox-alpha.md](0035-fable-standin-rates-for-ox-alpha.md) |
| Filter by exact multi-select model identifiers | [0036-model-filter-semantics.md](0036-model-filter-semantics.md) |
| Make durable history a paginated record listing | [0037-history-record-listing.md](0037-history-record-listing.md) |
| Price historical records against the current catalogue | [0038-retroactive-catalogue-pricing.md](0038-retroactive-catalogue-pricing.md) |
| Fuse the three proxy repositories into one monorepo | [0039-fuse-the-three-proxy-repos-into-one-monorepo.md](0039-fuse-the-three-proxy-repos-into-one-monorepo.md) |
| Three providers and three harnesses, paired but not fused | [0040-three-providers-and-three-harnesses.md](0040-three-providers-and-three-harnesses.md) |
| A site-wide provider picker drives the navigation | [0041-provider-picker-drives-the-navigation.md](0041-provider-picker-drives-the-navigation.md) |
| claude-proxy's dashboard is the design baseline, and UI design is delegated to a Fable subagent | [0042-claude-dashboard-is-the-design-baseline.md](0042-claude-dashboard-is-the-design-baseline.md) |
| Campaign state lives in the repo, and the wayfinder map is the control plane | [0043-campaign-state-lives-in-the-repo.md](0043-campaign-state-lives-in-the-repo.md) |
| Cost semantics: every model gets a price row | [0044-every-model-gets-a-price-row.md](0044-every-model-gets-a-price-row.md) |
| TanStack Router, repo-wide | [0045-tanstack-router-repo-wide.md](0045-tanstack-router-repo-wide.md) |
| The server accepts narrowly-scoped local writes | [0046-narrowly-scoped-local-writes.md](0046-narrowly-scoped-local-writes.md) |
| SQLite is the query substrate, with a forward-only migration ladder | [0047-sqlite-substrate-with-forward-only-migrations.md](0047-sqlite-substrate-with-forward-only-migrations.md) |
| Deletion policy, split by tier | [0048-deletion-policy-split-by-tier.md](0048-deletion-policy-split-by-tier.md) |
| Capture every body, redact on read and export | [0049-capture-every-body-redact-on-read.md](0049-capture-every-body-redact-on-read.md) |
| Keep port defaults verbatim and scope environment variable names per stack | [0050-stack-scoped-environment-variables.md](0050-stack-scoped-environment-variables.md) |
| Absorb ox into the shared lint gate at a warn tier, and split its delta by fixability | [0051-absorb-ox-into-the-shared-lint-gate.md](0051-absorb-ox-into-the-shared-lint-gate.md) |
| Inherited ratification flags survive the merge unchanged | [0052-inherited-ratification-flags-survive-the-merge.md](0052-inherited-ratification-flags-survive-the-merge.md) |
| The merged ADR record replaces both sources rather than joining them | [0053-the-merged-corpus-replaces-its-sources.md](0053-the-merged-corpus-replaces-its-sources.md) |
| Each stack keeps its own corpus at its own stack root | [0054-each-stack-keeps-its-own-corpus-root.md](0054-each-stack-keeps-its-own-corpus-root.md) |
| The package rename covers every non-import reference, gated by a grep | [0055-the-rename-covers-every-non-import-reference.md](0055-the-rename-covers-every-non-import-reference.md) |
| The docs gate asserts section indexes by file, and permits links out to source | [0056-the-docs-gate-asserts-indexes-by-file.md](0056-the-docs-gate-asserts-indexes-by-file.md) |
| The filter gate covers invocations, not records | [0057-the-filter-gate-covers-invocations-not-records.md](0057-the-filter-gate-covers-invocations-not-records.md) |
| Supersession is recorded from both ends | [0058-supersession-is-recorded-from-both-ends.md](0058-supersession-is-recorded-from-both-ends.md) |
| Land the fusion campaign incomplete, with the corpus migration still paused | [0059-land-the-fusion-campaign-incomplete.md](0059-land-the-fusion-campaign-incomplete.md) |
| A store's absence is typed, and never rendered as data | [0060-a-stores-absence-is-typed.md](0060-a-stores-absence-is-typed.md) |
| Three schemas, three ladders, one adapter contract | [0061-three-schemas-three-ladders-one-contract.md](0061-three-schemas-three-ladders-one-contract.md) |
| Three servers, and ox's server port moves off 8788 | [0062-three-servers-and-one-moved-port.md](0062-three-servers-and-one-moved-port.md) |
| Ox Alpha keeps its nested usage buckets, and the disjoint-bucket claim stays open | [0063-ox-alpha-keeps-its-nested-usage-buckets.md](0063-ox-alpha-keeps-its-nested-usage-buckets.md) |
| Tokens do not aggregate across providers | [0064-tokens-do-not-aggregate-across-providers.md](0064-tokens-do-not-aggregate-across-providers.md) |
| Cost and pricing_source are resolved at read time, never stored | [0065-cost-is-resolved-at-read-time.md](0065-cost-is-resolved-at-read-time.md) |
| Legacy ADR identifier map | [legacy-map.md](legacy-map.md) |
<!-- okq:index:end -->
