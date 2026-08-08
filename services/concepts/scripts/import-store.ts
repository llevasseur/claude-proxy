/**
 * One-time seed: push `logs/concepts.jsonl` into the deployed store.
 *
 * It posts through the real HTTP write path rather than generating SQL, so the
 * ids, the FTS rows and the skill rows are produced by exactly the code that
 * serves live writes — there is no second implementation of the schema to drift.
 * Writes are idempotent (the id is derived from the record), so re-running this
 * after a partial failure is safe and re-imports nothing.
 *
 *   pnpm --filter concepts import -- --url https://… --token "$CONCEPTS_TOKEN"
 *   pnpm --filter concepts import -- --dry-run
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Concept, isConcept, normalizeConcept } from '@claude-proxy/core';

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultStorePath(): string {
  // Same resolution rule `/teach` uses: the store's own env var wins, and its
  // parent directory is the log dir. Never search the filesystem for a checkout.
  const configured = process.env.CLAUDE_PROXY_STORE;
  if (configured) return join(dirname(resolve(configured)), 'concepts.jsonl');
  return resolve(HERE, '..', '..', '..', 'logs', 'concepts.jsonl');
}

/** Tolerant line parse: a corrupt line is reported and skipped, never fatal. */
function parseStore(text: string): { concepts: Concept[]; skipped: number } {
  const concepts: Concept[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isConcept(parsed)) concepts.push(normalizeConcept(parsed));
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { concepts, skipped };
}

async function main(): Promise<void> {
  const file = flag('file') ?? defaultStorePath();
  const dryRun = process.argv.includes('--dry-run');
  const url = (flag('url') ?? process.env.CONCEPTS_URL ?? '').replace(/\/+$/, '');
  const token = flag('token') ?? process.env.CONCEPTS_TOKEN;

  const { concepts, skipped } = parseStore(readFileSync(file, 'utf8'));
  console.log(`read ${concepts.length} concepts from ${file}${skipped > 0 ? ` (${skipped} lines skipped)` : ''}`);

  if (dryRun) {
    for (const concept of concepts) console.log(`  ${concept.savedAt}  ${concept.term}`);
    console.log('dry run — nothing sent');
    return;
  }

  if (!url || !token) {
    throw new Error('need --url and --token (or CONCEPTS_URL and CONCEPTS_TOKEN) unless --dry-run');
  }

  let created = 0;
  let already = 0;
  for (const concept of concepts) {
    const response = await fetch(`${url}/api/concepts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(concept),
    });
    if (!response.ok) throw new Error(`POST ${concept.term} failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { created: boolean };
    if (body.created) created += 1;
    else already += 1;
  }
  console.log(`imported ${created} concepts, ${already} already present`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
