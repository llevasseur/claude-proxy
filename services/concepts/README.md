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

### 1. Create the database

```sh
pnpm --filter concepts exec wrangler d1 create concepts
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_D1_DATABASE_ID`, and commit that — a D1 database id is not a
secret.

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
pnpm --filter concepts import -- --dry-run
```

Then:

```sh
CONCEPTS_URL=https://… CONCEPTS_TOKEN=… pnpm --filter concepts import
```

It posts through the real write path, so it is safe to re-run.

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
restore is `pnpm --filter concepts import` pointed at the backed-up file.
