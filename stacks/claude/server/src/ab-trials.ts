import { readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  type AbChoice,
  type AbRun,
  type AbSide,
  type AbTrial,
  type AbVersion,
  pickAgrees,
  readAbTrial,
  trialSetup,
} from './ab-trial-record.js';
import { openDb, openDbReadOnly } from './db/open.js';
import { parseJson, stringField } from './json.js';

/**
 * The `/ab` trials page's three routes: the list, one trial, and its delete.
 *
 * **The list reads `ab_trial`; a trial reads its record.** The table holds only what
 * the list renders, so an arm's full output, the rubric and the judge's reasons are
 * read from the label record in the Jev keep each time a trial is opened, and each
 * arm's instructions from the trial's own directory beside it. A record
 * that has left the keep is a 404 even while its row lingers until the next ingest.
 *
 * **A delete removes the record, not just the row.** The row is a view of the record,
 * and dropping only the row would bring it back the next time the keep is re-derived.
 * The trial's own working directory under `~/.my-command/ab/` is not touched: the
 * label record names it only through an arm's diff path, which is read, never trusted
 * as something to remove.
 */

export type { AbChoice, AbRun, AbSide, AbVersion };

/** One trial as the list renders it. */
export interface AbTrialRow {
  session: string;
  id: number;
  recordedAt: string;
  /** Without its leading slash. */
  command: string;
  args: string | null;
  mode: string | null;
  /** The scenario's name, or the fixture branch. */
  setup: string | null;
  verdict: AbChoice | null;
  confidence: string | null;
  pick: AbChoice | null;
  /** Null when there is no pick, or no verdict, to compare. */
  agrees: boolean | null;
  runs: Record<AbSide, { tokens: number | null; durationMs: number | null; toolUses: number | null }>;
}

/** One command's trials, counted across the whole table. */
export interface AbCommandTally {
  command: string;
  trials: number;
  /** Trials with a recorded pick. */
  picked: number;
  /** Picked trials whose pick matched the judge. */
  agreed: number;
}

export interface AbTrialsResponse {
  /** Newest first. */
  trials: AbTrialRow[];
  /** Most recently trialled command first. */
  commands: AbCommandTally[];
  meta: {
    /** False when there is no database, or one whose schema has not reached `ab_trial`. */
    substrate: boolean;
  };
}

export interface AbTrialResponse {
  trial: AbTrialRow;
  fixture: AbTrial['fixture'];
  scenario: string | null;
  rubric: string | null;
  versions: Record<AbSide, AbVersion>;
  runs: Record<AbSide, AbRun>;
  judge: AbTrial['judge'];
  /** Who recorded the pick, as the label says — `human` for a person. */
  pickBy: string | null;
  /** The record this was read from. */
  file: string;
}

export interface AbTrialDeleteResponse {
  deleted: {
    session: string;
    id: number;
    command: string;
    file: string;
    /** True when the record was its run's only one, so the run's directory went too. */
    removedRun: boolean;
  };
}

interface AbTrialDbRow extends Record<string, SQLOutputValue> {
  session: string;
  id: number;
  recorded_at: string;
  command: string;
  args: string | null;
  mode: string | null;
  setup: string | null;
  verdict: string | null;
  confidence: string | null;
  pick: string | null;
  a_tokens: number | null;
  b_tokens: number | null;
  a_duration_ms: number | null;
  b_duration_ms: number | null;
  a_tool_uses: number | null;
  b_tool_uses: number | null;
}

interface AbTallyDbRow extends Record<string, SQLOutputValue> {
  command: string;
  trials: number;
  picked: number;
  agreed: number;
}

/** A column the ingest wrote from {@link AbChoice}; anything else reads as no answer. */
function choiceOf(value: string | null): AbChoice | null {
  return value === 'a' || value === 'b' || value === 'tie' ? value : null;
}

function toRow(row: AbTrialDbRow): AbTrialRow {
  const verdict = choiceOf(row.verdict);
  const pick = choiceOf(row.pick);
  return {
    session: row.session,
    id: row.id,
    recordedAt: row.recorded_at,
    command: row.command,
    args: row.args,
    mode: row.mode,
    setup: row.setup,
    verdict,
    confidence: row.confidence,
    pick,
    agrees: pickAgrees(pick, verdict),
    runs: {
      a: { tokens: row.a_tokens, durationMs: row.a_duration_ms, toolUses: row.a_tool_uses },
      b: { tokens: row.b_tokens, durationMs: row.b_duration_ms, toolUses: row.b_tool_uses },
    },
  };
}

/**
 * Every ingested trial, newest first, with a tally per command. The page groups and
 * filters by command client-side, so the list takes no parameters.
 *
 * Read-only and never migrating, like `buildJevCalls`: a missing database or table is
 * an empty answer with `substrate: false`, not an error.
 */
export function buildAbTrials(logDir: string): AbTrialsResponse {
  const empty: AbTrialsResponse = { trials: [], commands: [], meta: { substrate: false } };
  let db: DatabaseSync;
  try {
    db = openDbReadOnly(logDir);
  } catch {
    return empty;
  }
  try {
    // SAFETY: every column is named in this select list and typed by `AbTrialDbRow`.
    const trials = (
      db
        .prepare(
          `SELECT session, id, recorded_at, command, args, mode, setup, verdict, confidence, pick,
                  a_tokens, b_tokens, a_duration_ms, b_duration_ms, a_tool_uses, b_tool_uses
             FROM ab_trial
            ORDER BY recorded_at DESC, session DESC, id DESC`,
        )
        .all() as AbTrialDbRow[]
    ).map(toRow);

    // SAFETY: each aggregate is aliased to the name `AbTallyDbRow` declares.
    const commands = (
      db
        .prepare(
          `SELECT command,
                  count(*) AS trials,
                  sum(CASE WHEN pick IS NOT NULL THEN 1 ELSE 0 END) AS picked,
                  sum(CASE WHEN pick IS NOT NULL AND pick = verdict THEN 1 ELSE 0 END) AS agreed
             FROM ab_trial
            GROUP BY command
            ORDER BY max(recorded_at) DESC, command`,
        )
        .all() as AbTallyDbRow[]
    ).map((row) => ({ command: row.command, trials: row.trials, picked: row.picked, agreed: row.agreed }));

    return { trials, commands, meta: { substrate: true } };
  } catch {
    // The schema step has not reached `ab_trial` yet.
    return empty;
  } finally {
    db.close();
  }
}

/** A keep directory name: what the recorder writes, and nothing that could leave the keep. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One trial's key, checked, and the record file it names. */
interface RecordLocation {
  id: number;
  file: string;
}

/** Where one trial's record lives, after checking both halves of its key. */
function recordPath(keep: string, session: string, rawId: string | number): RecordLocation {
  const id = Number(rawId);
  if (!SESSION_RE.test(session) || !Number.isInteger(id) || id < 0 || id > 999_999) {
    throw new Error(`invalid trial: ${session}/${rawId}`);
  }
  return { id, file: path.join(keep, session, `${String(id).padStart(6, '0')}.json`) };
}

/** The trial a record file holds. A missing, unreadable or non-trial record is `trial not found`. */
async function readTrialFile(file: string, label: string): Promise<AbTrial> {
  let trial: AbTrial | null = null;
  try {
    trial = readAbTrial(parseJson(await readFile(file, 'utf8')));
  } catch {
    // Falls through to the error below.
  }
  if (!trial) throw new Error(`trial not found: ${label}`);
  return trial;
}

/** The diff file `/ab` writes into a trial's own directory, one per judged output. */
const OUTPUT_DIFF_RE = /^output-\d+\.diff$/;

/**
 * The text an arm ran as its instructions. The record carries it when the trial wrote it
 * inline; otherwise it is the `a.md` or `b.md` `/ab` wrote into the trial's directory,
 * which the record names only through the arm's diff path. A diff that is not one of
 * that directory's `output-<n>.diff` files names no trial directory, so nothing is read.
 */
async function versionText(trial: AbTrial, side: AbSide): Promise<string | null> {
  const inline = trial.versions[side].text;
  if (inline !== null) return inline;
  const diff = trial.runs[side].diff;
  if (!diff || !path.isAbsolute(diff) || !OUTPUT_DIFF_RE.test(path.basename(diff))) return null;
  try {
    return await readFile(path.join(path.dirname(diff), `${side}.md`), 'utf8');
  } catch {
    // The trial directory was cleaned up; the page shows the ref alone.
    return null;
  }
}

/** One trial in full, read from its record in the keep. */
export async function buildAbTrial(keep: string, session: string, rawId: string): Promise<AbTrialResponse> {
  const { id, file } = recordPath(keep, session, rawId);
  const trial = await readTrialFile(file, `${session}/${id}`);
  const { a, b } = trial.runs;
  const [aText, bText] = await Promise.all([versionText(trial, 'a'), versionText(trial, 'b')]);
  return {
    trial: {
      session,
      id,
      recordedAt: trial.recordedAt,
      command: trial.command,
      args: trial.args,
      mode: trial.mode,
      setup: trialSetup(trial),
      verdict: trial.judge.verdict,
      confidence: trial.judge.confidence,
      pick: trial.pick,
      agrees: pickAgrees(trial.pick, trial.judge.verdict),
      runs: {
        a: { tokens: a.tokens, durationMs: a.durationMs, toolUses: a.toolUses },
        b: { tokens: b.tokens, durationMs: b.durationMs, toolUses: b.toolUses },
      },
    },
    fixture: trial.fixture,
    scenario: trial.scenario,
    rubric: trial.rubric,
    versions: { a: { ...trial.versions.a, text: aText }, b: { ...trial.versions.b, text: bText } },
    runs: trial.runs,
    judge: trial.judge,
    pickBy: trial.pickBy,
    file,
  };
}

/** One exchange per file, as `ingest-jev.ts` numbers them. */
const RECORD_FILE_RE = /^\d{6}\.json$/;

/**
 * Whether deleting this record leaves its run with nothing: no other numbered record,
 * and a `session.json` that says the run was a label, not a proxy run. Only then does
 * the run's directory go too — a proxy run that also holds calls keeps them.
 */
async function isLoneLabel(dir: string, file: string): Promise<boolean> {
  const names = await readdir(dir);
  if (names.some((name) => RECORD_FILE_RE.test(name) && name !== path.basename(file))) return false;
  try {
    return stringField(parseJson(await readFile(path.join(dir, 'session.json'), 'utf8')), 'kind') === 'ab';
  } catch {
    return false;
  }
}

/**
 * Delete one trial: its row, then its record in the keep.
 *
 * **The row goes first.** Its watermark goes with it, so if the unlink then fails the
 * next ingest finds an unwatermarked record and writes the row back — the page never
 * shows a trial whose record is gone, nor hides one whose record is still there.
 */
export async function deleteAbTrial(
  logDir: string,
  keep: string,
  session: string,
  rawId: string | number,
): Promise<AbTrialDeleteResponse> {
  const { id, file } = recordPath(keep, session, rawId);
  const trial = await readTrialFile(file, `${session}/${id}`);
  const dir = path.dirname(file);
  const removedRun = await isLoneLabel(dir, file);

  const db = openDb(logDir);
  try {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM ab_trial WHERE session = ? AND id = ?').run(session, id);
      db.prepare('DELETE FROM file_watermark WHERE path = ?').run(`jev/${session}/${path.basename(file)}`);
      if (removedRun) {
        // `ON DELETE CASCADE` takes anything else the run held.
        db.prepare('DELETE FROM jev_session WHERE session = ?').run(session);
        db.prepare('DELETE FROM file_watermark WHERE path LIKE ?').run(`jev/${session}/%`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }

  if (removedRun) await rm(dir, { recursive: true, force: true });
  else await unlink(file);

  return { deleted: { session, id, command: trial.command, file, removedRun } };
}
