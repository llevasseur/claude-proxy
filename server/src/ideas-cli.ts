/**
 * The ideas ledger from the command line — the interface an agent uses to record
 * what it proposed, read back what a human decided, and find out whether an idea
 * has already been considered. Reads the log directory directly, so it works with
 * no server running.
 *
 *   pnpm --filter server ideas list                                  # the whole ledger
 *   pnpm --filter server ideas list -s accepted                      # only what was signed off
 *   pnpm --filter server ideas list -s accepted --repo owner/name    # ... for one repo
 *   pnpm --filter server ideas list --area commands                  # ... for one area
 *   pnpm --filter server ideas list --json                           # machine-readable
 *   pnpm --filter server ideas add --json '[{"slug":"…", …}]'        # record proposals
 *   pnpm --filter server ideas add --json -                          # ... from stdin
 *   pnpm --filter server ideas list --available                        # what may be taken right now
 *   pnpm --filter server ideas claim --slug rolling-window --by feat/rolling-window
 *   pnpm --filter server ideas mark --slug rolling-window -s accepted
 *   pnpm --filter server ideas mark --slug rolling-window -s rejected -n "covered by /trends"
 *   pnpm --filter server ideas mark --slug rolling-window -s shipped -n "<PR url>"
 *   pnpm --filter server ideas file --slug rolling-window --area ui-ux
 *   pnpm --filter server ideas note --slug rolling-window --text "start with the reader"
 *   pnpm --filter server ideas prompt --slug rolling-window            # the /task prompt to build it
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
  claimableIdeaRows,
  countIdeaStatuses,
  IDEA_STATUSES,
  type IdeaEntry,
  type IdeaStatus,
  ideaAreaLabel,
  ideaCitation,
  ideaOf,
  ideaRows,
  ideaTaskPrompt,
  isIdeaArea,
  isIdeaStatus,
  isThreadId,
  parseCliArgs,
  parseIdeaAdds,
  SEED_IDEA_AREAS,
  similarAreas,
  similarIdeaSlugs,
} from '@claude-proxy/core';
import { reconcileIdeaPrs, renderIdeaPrTransition } from './ideas-pr.js';
import {
  addIdeasToStore,
  claimIdeasInStore,
  commentIdeasInStore,
  fileIdeasInStore,
  markIdeasInStore,
  readIdeasStore,
  resolveIdeasPath,
} from './ideas-store.js';
import { resolveLogDir } from './logs.js';

const USAGE = `usage:
  ideas list  [-s|--status <flags>] [--repo <slug>] [--area <area>] [--available] [--json]
  ideas add    --json <entries>|-
  ideas claim  --slug <slug> --by <holder> [--pr <url>] [--json]
  ideas mark   --slug <slug> -s|--status <flag> [-n|--note <text>] [--thread <id>] [--json]
  ideas file   --slug <slug> --area <area> [--thread <id>] [--json]
  ideas note   --slug <slug> --text <text> [--thread <id>] [--json]
  ideas sync   [--dry-run] [--thread <id>] [--json]
  ideas prompt --slug <slug> [--json]

  <flags>    comma-separated: proposed, accepted, claimed, rejected, shipped
  <slug>     for --slug, the idea's kebab-case key; for --repo, a git remote
             slug like owner/name — never an absolute checkout path, since this
             ledger is device-wide and shared across every repo on the machine
  <area>     a kebab-case classification. FREE TEXT: any word will do, and a new
             one opens a tab of its own. These are the ones already in use —
             ${SEED_IDEA_AREAS.map((s) => s.area).join(', ')}
  <entries>  a JSON array of { slug, title, rationale, evidence[], repo, area,
             status?, note? }, or - to read it from stdin. Each entry must cite
             at least one piece of evidence — { source, path } where source is
             open-question | changelog | deferral, or { source: "judge-note",
             bucket, id } — and an entry citing nothing is refused, not stored.
             'area' is required on the same footing: nothing new lands unfiled.

  { source: "command-gap" } is the one citation that needs NO locator, since a
  command nobody wrote has no file to point at. It is therefore the one a reader
  cannot check, and it is confined to the '${SEED_IDEA_AREAS[4]?.area}' area — cited from any
  other area, the entry is refused rather than stored.

  add refuses a slug already on the ledger in ANY status rather than
  overwriting it, and reports the collision; the other entries in the batch are
  still recorded. Its own output is always JSON, since its input is. It also
  reports near-miss areas under 'similarAreas' — 'infra' beside an existing
  'infrastructure' — and still records the entry. Fragmenting the vocabulary is
  a thing for a reader to notice, not a thing to refuse.

  mark needs a note for 'rejected' (the reason) and for 'shipped' (the PR url).
  'proposed' is the undo: it restores an idea to unsigned-off without erasing
  the entry or its note.

  claim is the FIRST thing an implementation run does, not something it does at
  PR-open time — that gap is what let two runs build the same accepted idea.
  It takes an 'accepted' idea, or a 'claimed' one whose claim has gone stale
  (6h with no PR recorded; a claim carrying --pr never goes stale). A claim held
  by someone else is refused, and the run picks a different idea. Re-claiming as
  the same --by is idempotent and is how a run attaches its --pr later.

  mark -s accepted RELEASES a claim — that is the explicit release beside the
  age-based expiry, for a run that gives up before the 6h is out. Every mark
  except 'shipped' drops the claim; 'shipped' keeps it as the record of who
  built the thing.

  list --available is what an implementation run should read: 'accepted' plus
  any 'claimed' idea whose claim has expired. Plain -s accepted misses an idea
  abandoned by a run that died, and -s accepted,claimed would take one out from
  under a live holder.

  file is how an idea changes area — a legacy entry showing as Unfiled, or one
  filed under the wrong heading. It is its OWN verb rather than a flag on mark,
  deliberately: folding the two together would let a status change move an idea
  between tabs as a side effect. file touches the area and nothing else — the
  status, the note and any claim are left exactly as they were.

  note writes the entry's 'comment': a human's own words about the idea, which
  /improve reads as extra build criteria. It is a DIFFERENT field from mark's
  -n/--note, which stays what it always was — the rejection reason, or the PR
  url on a shipped idea. Each write replaces the whole comment rather than
  appending to it, and --text "" clears it.

  mark --thread <id> records the marking session's own thread id on the entry, the
  same attribution a bucket verdict carries. It is the answer to 'who accepted
  this'; unlike a verdict there is no window behind an idea, so nothing is counted.

  sync reads the pull request linked on each 'claimed' and 'shipped' idea and
  moves the status to match, so nobody has to remember to. A merged PR ships the
  idea (with the PR url as the note, exactly as mark -s shipped writes it); a PR
  closed unmerged, or one whose head branch is gone from the remote, RELEASES the
  claim back to 'accepted'. An open PR changes nothing, and a 'shipped' idea is
  terminal — no later PR event un-ships work that landed. A linked PR the listing
  does not cover is reported and left alone rather than guessed at, since the
  listing reads one repo while this ledger is device-wide. --dry-run prints the
  plan and writes nothing. The scheduled 'maintain --apply' job runs this too,
  which is what makes the status change without anyone asking for it.

  prompt prints the ready-to-paste /task invocation that builds one idea,
  composed from the entry itself — title, rationale, the human's comment as
  build criteria, every citation, and the claim lines a run should take before
  it writes anything. It is DERIVED rather than stored, so it cannot go stale
  against a re-filed or re-commented entry, and the dashboard's copy button
  emits the same bytes. An orchestrator splitting accepted ideas across
  subagents reads this to know exactly what to hand each one; --json wraps it
  as { slug, prompt } for a caller that would rather not parse stdout.

  Only 'accepted' carries a human sign-off, and it is the only status /improve
  may act on. This CLI never sets one by itself.`;

/** Flags that stand alone. Empty for `add`, whose `--json` carries the payload. */
function booleanFlagsFor(command: string): string[] {
  return command === 'add' ? [] : ['json', 'available', 'dry-run'];
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
      const comment = r.comment ? `\n      comment: ${r.comment}` : '';
      const actor = r.by ? `\n      by: ${r.by.thread}` : '';
      const cites = r.evidence.map((e) => {
        const where = ideaCitation(e);
        return `        · ${e.source}: ${where}${e.quote ? ` — ${e.quote}` : ''}`;
      });
      // Its own row above the note — this is what a second run reads to decide
      // whether to walk away.
      const held = r.claim
        ? `\n      held by ${r.claim.by} since ${r.claim.at.slice(0, 16).replace('T', ' ')}${r.claim.pr ? ` — ${r.claim.pr}` : ''}`
        : '';
      const head = `  ${r.status.padEnd(8)} ${r.slug.padEnd(width)}  ${r.title}  [${r.repo} · ${ideaAreaLabel(r.area)}]${when ? `  updated ${when}` : ''}`;
      // Every line, not just the first: a bulleted rationale carries newlines.
      const why = r.rationale
        .split('\n')
        .map((l) => `      ${l}`.trimEnd())
        .join('\n');
      return [head, why, ...cites].join('\n') + held + note + comment + actor;
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
    if (flags.area !== undefined && !isIdeaArea(flags.area))
      throw new Error(`--area ${flags.area} is not a kebab-case area (a-z, 0-9, single dashes)`);
    const filter = {
      ...(flags.status ? { statuses: parseStatuses(flags.status) } : {}),
      ...(flags.repo ? { repo: flags.repo } : {}),
      ...(flags.area ? { area: flags.area } : {}),
    };
    // `--available` is "what may I take"; the default is "what is signed off".
    const rows = switches.has('available') ? claimableIdeaRows(store, filter) : ideaRows(store, filter);
    const counts = countIdeaStatuses(rows);
    if (json) {
      console.log(JSON.stringify({ rows, meta: { counts, file: resolveIdeasPath(logDir) } }, null, 2));
      return;
    }
    console.log(
      `${rows.length} idea(s) shown: ${counts.proposed} proposed, ${counts.accepted} accepted, ${counts.claimed} claimed, ${counts.rejected} rejected, ${counts.shipped} shipped`,
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
    // Same restraint as the slug look-alikes: reported, never refused.
    const areaHits = Object.fromEntries(
      adds.map((add) => [add.slug, similarAreas(existing, add.area)] as const).filter(([, hits]) => hits.length > 0),
    );

    const result = await addIdeasToStore(logDir, adds);
    console.log(
      JSON.stringify(
        { added: result.added, refused: result.refused, similar, similarAreas: areaHits, meta: { file: result.file } },
        null,
        2,
      ),
    );
    if (result.refused.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'claim') {
    if (!flags.slug) throw new Error('claim needs --slug <slug>');
    if (!flags.by)
      throw new Error(
        'claim needs --by <holder>: a branch, a run id, a person — whatever a second run can read and recognise as not itself',
      );

    const result = await claimIdeasInStore(logDir, [
      { slug: flags.slug, by: flags.by, ...(flags.pr === undefined ? {} : { pr: flags.pr }) },
    ]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    }
    if (result.unknown.length > 0) {
      if (!json) console.log(`no idea on the ledger is called: ${result.unknown.join(', ')} — nothing written`);
      process.exitCode = 1;
      return;
    }
    const [refusal] = result.refused;
    if (refusal) {
      // Exit 1, so a scripted run walks away rather than reading a zero exit as
      // permission to build what somebody else already is.
      if (!json) {
        console.log(
          refusal.heldBy
            ? `${refusal.slug} is already held by ${refusal.heldBy} since ${refusal.since} — pick a different idea`
            : `${refusal.slug} is ${refusal.status}, and only an accepted idea may be claimed`,
        );
      }
      process.exitCode = 1;
      return;
    }
    if (!json) {
      console.log(`claimed ${result.claimed.join(', ')} for ${flags.by} in ${result.file}`);
      console.log(renderRows(ideaRows(result.store, {}).filter((r) => result.claimed.includes(r.slug))).trimEnd());
    }
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

  if (command === 'file') {
    if (!flags.slug) throw new Error('file needs --slug <slug>');
    if (!flags.area) throw new Error('file needs --area <area>');
    if (!isIdeaArea(flags.area))
      throw new Error(`--area ${flags.area} is not a kebab-case area (a-z, 0-9, single dashes)`);
    if (flags.thread !== undefined && !isThreadId(flags.thread))
      throw new Error(`--thread ${flags.thread} is not a 16-hex-character thread id`);

    const result = await fileIdeasInStore(logDir, [
      { slug: flags.slug, area: flags.area, ...(flags.thread === undefined ? {} : { by: { thread: flags.thread } }) },
    ]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.unknown.length > 0) {
      console.log(`no idea on the ledger is called: ${result.unknown.join(', ')} — nothing written`);
      process.exitCode = 1;
      return;
    }
    console.log(`filed ${result.updated.join(', ')} under ${ideaAreaLabel(flags.area)} in ${result.file}`);
    console.log(renderRows(ideaRows(result.store, {}).filter((r) => result.updated.includes(r.slug))).trimEnd());
    return;
  }

  if (command === 'note') {
    if (!flags.slug) throw new Error('note needs --slug <slug>');
    // Distinguished from an absent flag, since '' is the documented clear.
    if (flags.text === undefined) throw new Error('note needs --text <text>, or --text "" to clear the comment');
    if (flags.thread !== undefined && !isThreadId(flags.thread))
      throw new Error(`--thread ${flags.thread} is not a 16-hex-character thread id`);

    const result = await commentIdeasInStore(logDir, [
      { slug: flags.slug, text: flags.text, ...(flags.thread === undefined ? {} : { by: { thread: flags.thread } }) },
    ]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.unknown.length > 0) {
      console.log(`no idea on the ledger is called: ${result.unknown.join(', ')} — nothing written`);
      process.exitCode = 1;
      return;
    }
    const what = flags.text.trim() ? 'commented on' : 'cleared the comment on';
    console.log(`${what} ${result.updated.join(', ')} in ${result.file}`);
    console.log(renderRows(ideaRows(result.store, {}).filter((r) => result.updated.includes(r.slug))).trimEnd());
    return;
  }

  if (command === 'sync') {
    if (flags.thread !== undefined && !isThreadId(flags.thread))
      throw new Error(`--thread ${flags.thread} is not a 16-hex-character thread id`);

    const result = await reconcileIdeaPrs(logDir, {
      dryRun: Boolean(flags['dry-run']),
      ...(flags.thread === undefined ? {} : { by: { thread: flags.thread } }),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      if (result.error) process.exitCode = 1;
      return;
    }
    if (result.error) {
      // Could not see GitHub at all. Distinct from "saw it, nothing to do".
      console.log(`could not read pull requests: ${result.error} — the ledger is untouched`);
      process.exitCode = 1;
      return;
    }
    for (const t of result.transitions) console.log(renderIdeaPrTransition(t));
    if (result.transitions.length === 0) console.log('no linked pull request implies a status change');
    if (result.unobserved.length > 0) {
      // Never guessed at: the listing reads one capped repo, the ledger is device-wide.
      console.log(`not covered by the listing, left alone: ${result.unobserved.map((l) => l.slug).join(', ')}`);
    }
    console.log(
      result.dryRun
        ? 'dry run — re-run without --dry-run to write this.'
        : result.file
          ? `written to ${result.file}`
          : 'nothing written',
    );
    return;
  }

  if (command === 'prompt') {
    if (!flags.slug) throw new Error('prompt needs --slug <slug>');
    const store = await readIdeasStore(logDir);
    const entry = ideaOf(store, flags.slug);
    if (!entry) {
      // The same refusal every other verb makes on an unknown slug: nothing is
      // invented to answer with, and `--json` still answers in JSON.
      if (json) console.log(JSON.stringify({ slug: flags.slug, unknown: [flags.slug] }, null, 2));
      else console.log(`no idea on the ledger is called: ${flags.slug}`);
      process.exitCode = 1;
      return;
    }
    const prompt = ideaTaskPrompt(entry);
    // Bare on stdout, so `ideas prompt --slug x | pbcopy` is the whole workflow.
    console.log(json ? JSON.stringify({ slug: entry.slug, prompt }, null, 2) : prompt);
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`[ideas] ${(err as Error).message}`);
  process.exitCode = 1;
});
