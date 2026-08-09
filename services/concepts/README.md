# concepts — the hosted concept store

The Cloudflare Worker that holds everything `/teach` has ever saved, so the
glossary is reachable from any machine and from any agent — including agents
running in a throwaway cloud box that has no copy of your files.

It is a D1 (SQLite) database behind two interfaces over the same data:

- **REST**, which `/teach` posts to and which `server/` will proxy.
- **MCP**, at `POST /mcp`, which is how an agent queries it.

Design rationale — why the database is truth here when ADR 0004 says files are,
why there is one token rather than two, why the MCP layer is hand-rolled — is in
[`docs/adrs/0005-host-the-concept-store.md`](../../docs/adrs/0005-host-the-concept-store.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Worker entry: auth, routing, the daily backup trigger |
| `src/store.ts` | Every SQL query; the only file that knows the schema |
| `src/db.ts` | The `Db` port — D1 in production, `node:sqlite` in tests |
| `src/mcp.ts` | JSON-RPC and the three tool definitions |
| `src/rest.ts` | The HTTP surface |
| `src/backup.ts` | Nightly commit of the corpus to a private git repo |
| `migrations/0001_init.sql` | The schema, and the source of truth for the tests |
| `scripts/import-store.ts` | One-time seed from `logs/concepts.jsonl` |

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

Listing, search and facets all accept `field`, `skill`, `since`, `hasNotes`,
`includeSuperseded` and `limit`.

## MCP tools

`concepts_list` returns the whole glossary compactly (no prose), which at
realistic corpus sizes is tens of kilobytes and cheap to call blind.
`concepts_get` and `concepts_search` return full records including notes and
tips. That split is deliberate: measured against the current corpus, a compact
entry averages ~148 bytes while one carrying notes and tips averages ~1.2 KB.

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

### 5. Seed from the existing file

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

A cron trigger commits the full corpus as JSONL to the private backup repo daily.
It compares the git blob sha of the new content against what is already there, so
an unchanged day produces no commit. This is the escape hatch that keeps the
"database is truth" decision reversible: the worst case is losing one day, and a
restore is `pnpm --filter concepts seed` pointed at the backed-up file.
