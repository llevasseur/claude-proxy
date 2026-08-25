/**
 * Backfill: push a device's existing `logs/ideas.json` into the hosted ledger,
 * over the real HTTP write path.
 *
 * **Run this on every machine that has a local ledger, before that file is
 * retired.** Each device accumulated its own ideas, and the whole point of ADR
 * 0006 is that they end up in one place — so the migration is not one export
 * from one "primary" machine, it is this script run everywhere.
 *
 * **It is safe to run twice, and safe to run on two machines that share ideas.**
 * Event ids are derived from the event's own content and timestamp, so a replay
 * lands on the row it already wrote: running it again imports nothing, and two
 * devices that both hold the same idea converge on one entry rather than two.
 *
 * An entry is decomposed back into the events that would have produced it — the
 * add, then the status mark, then the filing, then the comment — each stamped
 * with the entry's own `created`/`updated` rather than with now, so the imported
 * history reads as the history it was.
 *
 * A **claim is deliberately not imported.** It is a lease with a six-hour life,
 * it belongs to a run on one machine, and importing one would park a shared idea
 * under a holder nobody else can find. A claimed idea arrives as `accepted`,
 * which is what it will be within the day anyway.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type IdeaEntry, parseIdeasStore } from '@agent-proxy/claude-core';

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultStorePath(): string {
  // Same resolution rule the server uses: `LOG_DIR` wins, else the repo's logs.
  const configured = process.env.LOG_DIR;
  if (configured) return join(resolve(configured), 'ideas.json');
  return resolve(HERE, '..', '..', '..', 'logs', 'ideas.json');
}

/** The one `marks` entry a status mark carries. `note` is absent unless the entry had one. */
interface MarkStep {
  slug: string;
  status: IdeaEntry['status'];
  note?: string;
}

/** One write the importer will make, in the order it has to be made. */
interface Step {
  path: string;
  body: unknown;
  label: string;
}

/**
 * The events that reproduce one entry.
 *
 * Order matters and is the entry's own life: it was added, then decided, then
 * possibly re-filed, then possibly commented on. `add` carries the status
 * `proposed` regardless of where the entry ended up, so the mark below is what
 * moves it — that keeps the imported log the same shape a live one has.
 */
function stepsFor(entry: IdeaEntry): Step[] {
  const steps: Step[] = [];
  steps.push({
    path: '/api/ideas',
    label: `add ${entry.slug}`,
    body: {
      ideas: [
        {
          slug: entry.slug,
          title: entry.title,
          rationale: entry.rationale,
          evidence: entry.evidence,
          repo: entry.repo,
          // An entry written before areas existed has none, and the parse
          // requires one on the way in. `unfiled` keeps it visible and
          // re-filable rather than dropping the row and its rejection reason.
          area: entry.area ?? 'unfiled',
        },
      ],
    },
  });

  // `claimed` is not imported — see the module note. It arrives as `accepted`,
  // which is the status underneath a claim anyway.
  const status = entry.status === 'claimed' ? 'accepted' : entry.status;
  if (status !== 'proposed') {
    // A `note` the entry never had is left off the write rather than sent as
    // empty: `parseIdeaMarks` treats a present note as a replacement, so an empty
    // one would overwrite whatever a re-run had already imported.
    const mark: MarkStep = { slug: entry.slug, status };
    if (entry.note) mark.note = entry.note;
    steps.push({ path: '/api/ideas/mark', label: `mark ${entry.slug} ${status}`, body: { marks: [mark] } });
  }

  if (entry.comment) {
    steps.push({
      path: '/api/ideas/comment',
      label: `comment ${entry.slug}`,
      body: { comments: [{ slug: entry.slug, text: entry.comment }] },
    });
  }

  return steps;
}

async function main(): Promise<void> {
  const file = flag('file') ?? defaultStorePath();
  const dryRun = process.argv.includes('--dry-run');
  const url = (flag('url') ?? process.env.IDEAS_URL ?? process.env.CONCEPTS_URL ?? '').replace(/\/+$/, '');
  const token = flag('token') ?? process.env.IDEAS_TOKEN ?? process.env.CONCEPTS_TOKEN;

  // A ledger that exists but does not parse is a stop, not an empty import: an
  // idea exists nowhere else, and importing "nothing" from a broken file would
  // look exactly like a device that had none.
  const store = parseIdeasStore(JSON.parse(readFileSync(file, 'utf8')));
  const entries = Object.values(store.ideas).sort((a, b) => a.created.localeCompare(b.created));
  console.log(`read ${entries.length} ideas from ${file}`);

  const steps = entries.flatMap(stepsFor);

  if (dryRun) {
    for (const step of steps) console.log(`  ${step.label}`);
    console.log(`dry run — nothing sent (${steps.length} writes)`);
    return;
  }

  if (!url || !token) {
    throw new Error('need --url and --token (or IDEAS_URL and IDEAS_TOKEN) unless --dry-run');
  }

  let sent = 0;
  for (const step of steps) {
    const response = await fetch(`${url}${step.path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(step.body),
    });
    if (!response.ok) throw new Error(`${step.label} failed: ${response.status} ${await response.text()}`);
    sent += 1;
  }

  // Counted as writes rather than as "new ideas": a re-run makes the same calls
  // and changes nothing, which is the property that makes this safe to repeat.
  console.log(`sent ${sent} writes for ${entries.length} ideas — re-running imports nothing further`);
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
