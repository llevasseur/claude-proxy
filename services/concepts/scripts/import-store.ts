/**
 * One-time seed: push `logs/concepts.jsonl` into the deployed store over the
 * real HTTP write path, so ids, FTS rows and skill rows come from the code that
 * serves live writes. Writes are idempotent, so re-running after a partial
 * failure re-imports nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Concept, isConcept, normalizeConcept } from '@claude-proxy/core';
import { flagField, isJsonRecord, parseJson } from '../src/json.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultStorePath(): string {
  // Same resolution rule `/teach` uses: the store's own env var wins, and its
  // parent directory is the log dir.
  const configured = process.env.CLAUDE_PROXY_STORE;
  if (configured) return join(dirname(resolve(configured)), 'concepts.jsonl');
  return resolve(HERE, '..', '..', '..', 'logs', 'concepts.jsonl');
}

/** What one pass over the file yielded, kept together so the skip count is reported rather than lost. */
interface StoreParse {
  concepts: Concept[];
  skipped: number;
}

/** Tolerant line parse: a corrupt line is reported and skipped, never fatal. */
function parseStore(text: string): StoreParse {
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
    const body = parseJson(await response.text());
    if (isJsonRecord(body) && flagField(body, 'created')) created += 1;
    else already += 1;
  }
  console.log(`imported ${created} concepts, ${already} already present`);
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
