/**
 * The ideas ledger from the command line — the interface an agent uses to record
 * what it proposed, read back what a human decided, and find out whether an idea
 * has already been considered. Reads the log directory directly, so it works with
 * no server running.
 *
 *   pnpm --filter server ideas list                                  # the whole ledger
 *   pnpm --filter server ideas list -s accepted                      # only what was signed off
 *   pnpm --filter server ideas list -s accepted --repo owner/name    # ... for one repo
 *   pnpm --filter server ideas list --json                           # machine-readable
 *   pnpm --filter server ideas add --json '[{"slug":"…", …}]'        # record proposals
 *   pnpm --filter server ideas add --json -                          # ... from stdin
 *   pnpm --filter server ideas mark --slug rolling-window -s accepted
 *   pnpm --filter server ideas mark --slug rolling-window -s rejected -n "covered by /trends"
 *   pnpm --filter server ideas mark --slug rolling-window -s shipped -n "<PR url>"
 *
 * **This is not the suggestions CLI and shares no store with it.** A suggestion is
 * counted from transcripts and traces back to source sessions; an idea is
 * invented, and the only thing that makes it actionable is the recorded human
 * sign-off `accepted` carries. `suggestions list` never returns an idea and
 * `ideas list` never returns a suggestion — two evidence standards, one file
 * each.
 *
 * `add` is refused on a slug already present in any status, including
 * `rejected`. A rejected idea coming back on every run is the failure the slug
 * key exists to prevent, and the rejection reason is the most valuable row in the
 * file.
 */
import {
  countIdeaStatuses,
  IDEA_STATUSES,
  type IdeaEntry,
  type IdeaStatus,
  ideaRows,
  isIdeaStatus,
  isThreadId,
  parseCliArgs,
  parseIdeaAdds,
  similarIdeaSlugs,
} from '@claude-proxy/core';
import { addIdeasToStore, markIdeasInStore, readIdeasStore, resolveIdeasPath } from './ideas-store.js';
import { resolveLogDir } from './logs.js';

const USAGE = `usage:
  ideas list  [-s|--status <flags>] [--repo <slug>] [--json]
  ideas add    --json <entries>|-
  ideas mark   --slug <slug> -s|--status <flag> [-n|--note <text>] [--thread <id>] [--json]

  <flags>    comma-separated: proposed, accepted, rejected, shipped
  <slug>     for --slug, the idea's kebab-case key; for --repo, a git remote
             slug like owner/name — never an absolute checkout path, since this
             ledger is device-wide and shared across every repo on the machine
  <entries>  a JSON array of { slug, title, rationale, evidence[], repo,
             status?, note? }, or - to read it from stdin. Each entry must cite
             at least one piece of evidence — { source, path } where source is
             open-question | changelog | deferral, or { source: "judge-note",
             bucket, id } — and an entry citing nothing is refused, not stored.

  add refuses a slug already on the ledger in ANY status rather than
  overwriting it, and reports the collision; the other entries in the batch are
  still recorded. Its own output is always JSON, since its input is.

  mark needs a note for 'rejected' (the reason) and for 'shipped' (the PR url).
  'proposed' is the undo: it restores an idea to unsigned-off without erasing
  the entry or its note.

  mark --thread <id> records the marking session's own thread id on the entry, the
  same attribution a bucket verdict carries. It is the answer to 'who accepted
  this'; unlike a verdict there is no window behind an idea, so nothing is counted.

  Only 'accepted' carries a human sign-off, and it is the only status /improve
  may act on. This CLI never sets one by itself.`;

/** Flags that stand alone. Empty for `add`, whose `--json` carries the payload. */
function booleanFlagsFor(command: string): string[] {
  return command === 'add' ? [] : ['json'];
}

function parseStatuses(raw: string): IdeaStatus[] {
  return raw.split(',').map((part) => {
    const status = part.trim();
    if (!isIdeaStatus(status)) throw new Error(`invalid status: ${status} (expected ${IDEA_STATUSES.join(', ')})`);
    return status;
  });
}

/** Everything on stdin, for `add --json -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** One idea per block: the key line, then the rationale, then what it cites. */
function renderRows(rows: readonly IdeaEntry[]): string {
  if (rows.length === 0) return 'no ideas match.';
  const width = Math.max(...rows.map((r) => r.slug.length));
  return rows
    .map((r) => {
      const when = r.updated ? r.updated.slice(0, 10) : '';
      const note = r.note ? `\n      note: ${r.note}` : '';
      const actor = r.by ? `\n      by: ${r.by.thread}` : '';
      const cites = r.evidence.map((e) => {
        const where = e.path ?? (e.bucket === undefined ? '' : `bucket ${e.bucket}/${e.id ?? ''}`);
        return `        · ${e.source}: ${where}${e.quote ? ` — ${e.quote}` : ''}`;
      });
      const head = `  ${r.status.padEnd(8)} ${r.slug.padEnd(width)}  ${r.title}  [${r.repo}]${when ? `  ${when}` : ''}`;
      return [head, `      ${r.rationale}`, ...cites].join('\n') + note + actor;
    })
    .join('\n');
}

async function run(argv: readonly string[]): Promise<void> {
  const first = argv[0] ?? '';
  const command = first && !first.startsWith('-') ? first : 'list';

  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  // `--help` no longer needs pre-screening against raw argv: the shared parser
  // treats it as a switch, so it can never be read as a flag wanting a value.
  const { flags, switches, help } = parseCliArgs(rest, {
    aliases: { s: 'status', n: 'note', t: 'thread' },
    booleans: booleanFlagsFor(command),
  });
  if (help || first === 'help') {
    console.log(USAGE);
    return;
  }
  const json = switches.has('json');
  const logDir = resolveLogDir();

  if (command === 'list') {
    const store = await readIdeasStore(logDir);
    const rows = ideaRows(store, {
      ...(flags.status ? { statuses: parseStatuses(flags.status) } : {}),
      ...(flags.repo ? { repo: flags.repo } : {}),
    });
    const counts = countIdeaStatuses(rows);
    if (json) {
      console.log(JSON.stringify({ rows, meta: { counts, file: resolveIdeasPath(logDir) } }, null, 2));
      return;
    }
    console.log(
      `${rows.length} idea(s) shown: ${counts.proposed} proposed, ${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.shipped} shipped`,
    );
    console.log(renderRows(rows));
    return;
  }

  if (command === 'add') {
    if (flags.json === undefined) throw new Error('add needs --json <entries>, or --json - to read stdin');
    const payload = flags.json === '-' ? await readStdin() : flags.json;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch (err) {
      throw new Error(`--json is not valid JSON: ${(err as Error).message}`);
    }
    const adds = parseIdeaAdds(raw);

    // Look-alikes are reported, never refused — only a reader can tell a rename
    // from a genuine sibling.
    const existing = await readIdeasStore(logDir);
    const similar = Object.fromEntries(
      adds
        .map((add) => [add.slug, similarIdeaSlugs(existing, add.slug)] as const)
        .filter(([, hits]) => hits.length > 0),
    );

    const result = await addIdeasToStore(logDir, adds);
    console.log(
      JSON.stringify({ added: result.added, refused: result.refused, similar, meta: { file: result.file } }, null, 2),
    );
    if (result.refused.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'mark') {
    if (!flags.slug) throw new Error('mark needs --slug <slug>');
    if (!flags.status) throw new Error('mark needs --status <flag>');
    const [status] = parseStatuses(flags.status);
    if (!status) throw new Error('mark needs --status <flag>');
    if ((status === 'rejected' || status === 'shipped') && !flags.note) {
      throw new Error(
        status === 'rejected'
          ? 'mark -s rejected needs the reason: -n "<why>". A rejection with no reason is the row a later run most needs.'
          : 'mark -s shipped needs the PR url: -n "<url>". `shipped` is a claim about something that landed.',
      );
    }

    if (flags.thread !== undefined && !isThreadId(flags.thread)) {
      throw new Error(`--thread ${flags.thread} is not a 16-hex-character thread id`);
    }
    const result = await markIdeasInStore(logDir, [
      {
        slug: flags.slug,
        status,
        ...(flags.note === undefined ? {} : { note: flags.note }),
        ...(flags.thread === undefined ? {} : { by: { thread: flags.thread } }),
      },
    ]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.unknown.length > 0) {
      // Nothing was written for it: a mark on a slug the ledger lacks is a typo.
      console.log(`no idea on the ledger is called: ${result.unknown.join(', ')} — nothing written`);
      process.exitCode = 1;
      return;
    }
    console.log(`marked ${result.updated.join(', ')} ${status} in ${result.file}`);
    // Only the entry that moved; the whole ledger would bury it.
    console.log(renderRows(ideaRows(result.store, {}).filter((r) => result.updated.includes(r.slug))).trimEnd());
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`[ideas] ${(err as Error).message}`);
  process.exitCode = 1;
});
