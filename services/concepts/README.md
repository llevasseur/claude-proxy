# operator — the hosted concept store and ideas ledger

**The directory is named after the first dataset, not the scope.** This Worker
deploys as `operator` over a D1 database called `operator-db`, and it now serves
three datasets: the **concepts** glossary (ADR 0005), the **ideas** ledger
(ADR 0006), and authored Markdown **notes**. Auth, the `Db` port, the `/mcp`
dispatch, and the nightly backup are shared — which is why each dataset lives
here rather than in a separate Worker with its own deploy, token, cron, and
backup repo.

The Cloudflare Worker that holds everything `/teach` has ever saved, so the
glossary is reachable from any machine and from any agent — including agents
running in a throwaway cloud box that has no copy of your files. And everything
`/ideate` has ever proposed, so an idea accepted on one machine is visible on
every machine and a new proposal is deduped against what every machine already
holds.

It is a D1 (SQLite) database behind two interfaces over the same data:

- **REST**, which `/teach` posts to and which `server/` will proxy.
- **MCP**, at `POST /mcp`, which is how an agent queries it. It implements
  revisions `2025-06-18` and `2026-07-28` — see [MCP protocol
  revisions](#mcp-protocol-revisions).

Design rationale — why the database is truth here when ADR 0004 says files are,
why there is one token rather than two, why the MCP layer is hand-rolled — is in
[`docs/adrs/0005-host-the-concept-store.md`](../../docs/adrs/0005-host-the-concept-store.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Worker entry: auth, routing, the daily backup trigger |
| `src/store.ts` | Every concepts SQL query; the only file that knows that schema |
| `src/ideas.ts` | The ideas event log, its replay through `packages/core`, and the atomic claim |
| `src/notes.ts` | Immutable note revisions, current projection, search, pagination, archive, and conflicts |
| `src/db.ts` | The `Db` port — D1 in production, `node:sqlite` in tests |
| `src/mcp.ts` | JSON-RPC, protocol negotiation and per-request checks, and tool definitions |
| `src/rest.ts` | The HTTP surface |
| `src/backup.ts` | Nightly commit of all datasets to a private git repo |
| `migrations/0001_init.sql` | The concepts schema, and the source of truth for the tests |
| `migrations/0002_ideas.sql` | The ideas schema — the event log and the claim lease |
| `migrations/0003_notes.sql` | Note revisions, current-note projection, archive state, and FTS |
| `scripts/import-store.ts` | One-time seed from `logs/concepts.jsonl` |
| `scripts/import-ideas.ts` | Per-device backfill from `logs/ideas.json` |

## How the tests reach the database

D1 *is* SQLite, so `test/harness.ts` runs the production SQL — the same
`migrations/0001_init.sql`, the same FTS5 virtual table, the same `bm25()`
ranking — through `node:sqlite` in memory. Nothing is mocked and there is no
second implementation of the schema: a query the suite accepts is a query D1
accepts. `pnpm --filter concepts test` needs no Cloudflare account and no
network.

## The data model in one paragraph

The store is **append-only**. Every `/teach` inserts one immutable row, and
re-teaching a term adds a *version* rather than overwriting one. Reads return
the newest version per term unless asked for `includeSuperseded`, so the
history is there when you want to see how an understanding changed. Row ids are
ULIDs whose random half is derived from a hash of the record itself, which makes
writes idempotent and makes an export/import round trip preserve ids exactly.
The full record is stored verbatim in a `document` column, because that is the
only representation that still distinguishes a field that was never recorded
from one recorded empty — a distinction the concept detail view depends on.

## HTTP surface

Every route except `/health` requires `Authorization: Bearer $CONCEPTS_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated liveness check, used by the deploy workflow |
| `POST /api/concepts` | Save one concept. Idempotent; `201` when new, `200` when replayed |
| `GET /api/concepts` | Compact listing. `?facets=true` adds field and skill counts |
| `GET /api/concepts/concept?term=` or `?id=` | One concept in full, plus its older versions |
| `GET /api/concepts/search?q=` | BM25 full-text search |
| `GET /api/concepts/export` | The whole corpus as JSONL |
| `GET /api/ideas` | The ledger, with per-status and per-area counts. `?status=`, `?repo=`, `?area=`, `?available=true` |
| `GET /api/ideas/idea?slug=` | One idea by its key. `404` when no idea was ever added under it |
| `GET /api/ideas/export` | The whole ledger as JSON, in the shape `logs/ideas.json` held |
| `POST /api/ideas` | Record proposals. Refuses a slug already present in any status, and reports look-alikes |
| `POST /api/ideas/mark` | Change statuses. Every mark but `shipped` releases the claim |
| `POST /api/ideas/claim` | Take ideas. One atomic conditional write decides a race |
| `POST /api/ideas/file` | Re-file under an area. Touches nothing else |
| `POST /api/ideas/comment` | Write the human-authored build criteria |
| `GET /api/notes` | Cursor-page notes by last successful edit; `?archived=true` switches views |
| `GET /api/notes/note?id=` | One note with its full Markdown body |
| `GET /api/notes/search?q=` | Search current active titles and Markdown bodies |
| `POST /api/notes` | Create a note from `{title, body}` |
| `POST /api/notes/update` | Expected-version update; stale writes return 409 and remain retained |
| `POST /api/notes/archive` | Reversibly archive by `{id}` |
| `POST /api/notes/restore` | Restore by `{id}` without changing recency |

Listing, search and facets all accept `field`, `skill`, `since`, `hasNotes`,
`includeSuperseded` and `limit`.

## The ideas ledger in one paragraph

It is an **append-only event log** — `add`, `mark`, `file`, `comment` — replayed
through `packages/core/src/ideas.ts` on every read, so no status, evidence or
filing rule is restated in SQL and the hosted ledger cannot disagree with the CLI
about what a mark means. Replay orders by timestamp and then by an insertion
`seq` rather than by id, because a derived ULID's low bits are a hash and two
events sharing a millisecond would otherwise replay in hash order. **Claiming is
the one exception**, and the one thing replay cannot arbitrate: it is a mutable
lease row taken by a single `INSERT … ON CONFLICT DO UPDATE … WHERE` whose
`changes` count decides which of two racing runs won. Even there the six-hour
cutoff comes from `IDEA_CLAIM_TTL_MS` rather than being written out again.

## MCP protocol revisions

The server implements MCP `2025-06-18`, used by current Codex clients, and
`2026-07-28`. Both are stateless here: every answer is one `application/json`
body, the server sends no messages of its own, and it issues no session id.

What that means for a client:

- **A `2025-06-18` client initializes normally.** The server returns its tools
  capability, identity, and instructions, then acknowledges
  `notifications/initialized`. Later requests carry the negotiated
  `MCP-Protocol-Version` header; no server-side session is created.
- **A `2026-07-28` client declares the version on every request**, in `params._meta` under
  `io.modelcontextprotocol/protocolVersion` *and* in the `MCP-Protocol-Version`
  header. The two must agree; there is no handshake.
- **A `2026-07-28` client also mirrors `Mcp-Method`**, and `Mcp-Name` on a
  `tools/call`, into the headers.
  A missing or disagreeing header is `400 Bad Request` with JSON-RPC code
  `-32020` (`HeaderMismatch`).
- **A `2026-07-28` client can ask `server/discover`** for the supported versions, capabilities and
  identity in one call. It is optional — any RPC can be sent cold — but it is
  the cheapest way to see what is here. The result declares `ttlMs: 0` and
  `cacheScope: private`, so clients never reuse discovery across connections or
  treat this authenticated server's metadata as shared state.
- **A version this server does not implement** comes back as `400` with code
  `-32022` (`UnsupportedProtocolVersionError`), whose `data.supported` lists
  both versions it does.
- **An unknown method** is `404` with code `-32601`, carrying a JSON-RPC body so
  a client can tell a modern MCP endpoint from a host that serves no MCP at all.

## MCP tools

`concepts_list` returns the whole glossary compactly (no prose), which at
realistic corpus sizes is tens of kilobytes and cheap to call blind.
`concepts_get` and `concepts_search` return full records including notes and
tips. That split is deliberate: measured against the current corpus, a compact
entry averages ~148 bytes while one carrying notes and tips averages ~1.2 KB.

The ideas half splits the same way. `ideas_list` is the browse — the ledger,
filtered, with counts. `ideas_get` is the **query by key**: an idea's key is its
kebab-case slug and nothing else, so a client holding one fetches that idea
whole rather than listing the ledger and filtering it locally. That key is the
same string everywhere it appears — the dedupe key `ideas_add` checks, the
`slug` argument `ideas_claim` and `ideas_mark` take, and the dashboard's
`/ideas/<slug>` permalink, where a fingerprint button beside the title copies it
so a human can hand one idea to an agent. A key nothing was added under comes
back as a tool error; a *rejected* key answers normally, carrying the reason it
was turned down, which is what stops the idea being proposed a second time.

Notes expose `notes_list`, `notes_search`, `notes_get`, `notes_create`,
`notes_update`, `notes_archive`, and `notes_restore`. List and search return only
metadata and a derived excerpt; get returns the full Markdown. Every update must
carry the expected version. If two writers race, one advances the current
projection and the other receives a structured stale-version conflict whose
attempted revision remains in the immutable history.

The complete Notes contract, including REST and tool examples, cursor and excerpt
semantics, server-only credentials, dashboard autosave/SSE, and recovery steps, is
in [Operator notes](../../docs/features/operator-notes.md).

---

## Operator setup

**These steps are documented, not automated.** They create billable resources
and handle secrets, so run them yourself.

### 1. The database

The Worker deploys as `operator` and binds the existing `operator-db` D1
database as `operator_db`. Its `database_id` is already in `wrangler.jsonc` — a
D1 database id is not a secret, so it is committed.

To point this at a different database instead, create one and copy the printed
`database_id` over the one in `wrangler.jsonc`:

```sh
pnpm --filter concepts exec wrangler d1 create <name>
```

### 2. Apply the schema

```sh
pnpm --filter concepts schema:apply
```

### 3. Set the secrets

```sh
pnpm --filter concepts exec wrangler secret put CONCEPTS_TOKEN
pnpm --filter concepts exec wrangler secret put BACKUP_GITHUB_TOKEN
```

Generate the token with something like `openssl rand -base64 32`. It is the
single credential for both reading and writing — see ADR 0005 for why there is
not a separate read-only one. **Never commit it**: client config references it
as `${CONCEPTS_TOKEN}` from the environment.

`BACKUP_GITHUB_TOKEN` is a fine-grained PAT with `contents: write` on the
private backup repo and nothing else. Set `BACKUP_REPO` in `wrangler.jsonc`
`vars` to that repo's `owner/name`. Leaving either unset disables the backup
rather than failing the deploy.

### 4. Deploy

```sh
pnpm --filter concepts deploy
```

Thereafter GitHub Actions deploys on every merge to `main` that touches this
package — see `.github/workflows/deploy-concepts.yml`. It needs a
`CLOUDFLARE_API_TOKEN` repository secret with the *Edit Cloudflare Workers*
template, plus a `CLOUDFLARE_ACCOUNT_ID` secret. Set the `CONCEPTS_URL`
repository *variable* to the deployed URL to enable the post-deploy smoke check.

### 5. Seed from the existing files

Dry-run first, which needs no credentials:

```sh
pnpm --filter concepts seed --dry-run
```

Then:

```sh
CONCEPTS_URL=https://… CONCEPTS_TOKEN=… pnpm --filter concepts seed
```

It posts through the real write path, so it is safe to re-run — row ids are
derived from record content, so a replay updates nothing.

The script is named `seed` rather than `import` on purpose: `import` is a
built-in pnpm subcommand, so `pnpm --filter concepts import` is intercepted by
pnpm and never reaches the script.

The ideas ledger has its own importer, and it is run differently:

```sh
pnpm --filter concepts seed:ideas --dry-run
pnpm --filter concepts seed:ideas
```

**Run it on every machine that has a `logs/ideas.json`, not just one.** Each
device accumulated its own ideas while the ledger was local, and the point of
ADR 0006 is that they end up in one place. It is safe to run twice and safe to
run on two devices holding the same idea, because event ids are derived from
event content — a replay lands on the row it already wrote. A **claim is not
imported**: it is a six-hour lease belonging to a run on one machine, so a
claimed idea arrives as `accepted`.

**Do not delete `logs/ideas.json` yet.** The order is: this service ships,
`/ideate` and `/improve` are repointed in the `my-command` repo and synced to
every device, and only then the file is retired. The reverse order silently drops
ideas from any device still running the old commands.

`seed` reads `.env` from this package when one exists, so the usual setup is to
put both values there once and then run the bare command:

```sh
# services/concepts/.env — gitignored
CONCEPTS_URL=https://…
CONCEPTS_TOKEN=…
```

```sh
pnpm --filter concepts seed
```

`.env` and `.env.*` are gitignored, so the token cannot be committed from here.
Treat this file as a cache, not the system of record: `wrangler secret put`
writes the only copy Cloudflare keeps and never reads it back, so a token that
exists solely in `.env` is one `rm` away from being unrecoverable. Keep the
authoritative copy in a password manager.

To avoid the value on disk entirely, store a secret reference instead and run
the script under `op run`, which resolves it into the child process:

```sh
# services/concepts/.env
CONCEPTS_TOKEN=op://<vault>/<item>/credential
```

```sh
op run --env-file=services/concepts/.env -- pnpm --filter concepts seed
```

Running `pnpm --filter concepts seed` directly with a reference in `.env` sends
the literal `op://…` string as the bearer token and fails with `401
{"error":"unauthorized"}` — the reference is only resolved under `op run`.

### 6. Point agents at it

```sh
claude mcp add --scope user --transport http concepts https://… \
  --header "Authorization: Bearer $CONCEPTS_TOKEN"
```

Use `--scope user` on your own machines. Disposable cloud boxes get the
committed project-scoped `.mcp.json`, which reads the token from the
environment rather than carrying it.

## Backups

A cron trigger commits **all three datasets** to the private backup repo daily —
the corpus as `concepts.jsonl`, the ledger as `ideas.json`, and the complete
notes projection plus revision history as `notes.json`. Each is compared by
git blob sha against what is already there, so an unchanged day produces no
commit and a day on which only one dataset moved touches only that file. This is
the escape hatch that keeps the "database is truth" decision reversible for all
hosted datasets: the worst case is losing one day. Concepts and ideas can be
restored with `pnpm --filter concepts seed` or `seed:ideas` pointed at the
backed-up file; `notes.json` retains both tables needed to reconstruct the notes
projection, immutable revisions, archive state, and FTS index.

There is no Notes import command. Recover into a clean migrated D1 database by
inserting every exported revision, then every current projection row, and rebuilding
FTS from every revision. Validate every current pointer, version,
archive timestamp, and active/archived/revision/conflict count before switching
clients; the detailed procedure is in
[Operator notes](../../docs/features/operator-notes.md#backup-and-recovery).

**A dataset added to this Worker is added to the backup too, or the ADR 0004
carve-out is unpaid.** That is why all three exports go through one loop in
`src/backup.ts` rather than one function each.
