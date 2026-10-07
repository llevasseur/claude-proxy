import {
  type JsonInput,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  numberField,
  objectField,
  stringArrayField,
  stringField,
} from './json.js';

/**
 * One `/ab` trial, read out of the label record `my-command-tools jev-record label`
 * writes into the Jev keep.
 *
 * The record is `{ v, id, kind: "ab", recordedAt, trial, label }`, where `trial` is the
 * trial's own `trial.json` verbatim and `label` is the person's pick as the recorder
 * saw it. Both `db/ingest-jev.ts` (for the list columns) and `ab-trials.ts` (for the
 * detail page) read it through here, so the two can never disagree on a field.
 *
 * Every field but `command` is optional on the way in: the trial format belongs to
 * another repository, and a field it stops writing should blank a cell, not drop the
 * trial.
 */

/** Which arm of a trial. */
export type AbSide = 'a' | 'b';

/** What a judge or a person can answer: one arm, or neither. */
export type AbChoice = AbSide | 'tie';

export interface AbRun {
  /** The arm's final message, in full. Markdown as the command wrote it. */
  output: string | null;
  title: string | null;
  toolUses: number | null;
  tokens: number | null;
  durationMs: number | null;
  refusals: number | null;
  refusalLines: string[];
  /** How the run ended, as `/ab` graded it — `correct` when it closed the way the command says to. */
  close: string | null;
  closeReason: string | null;
  /** Steps the arm deliberately did not take, such as a publish run as `--dry-run`. */
  skipped: string[];
  prAction: string | null;
  prs: string[];
  /** Where the arm's diff was saved, outside this repository. */
  diff: string | null;
}

export interface AbVersion {
  ref: string | null;
  lines: number | null;
}

export interface AbTrial {
  recordedAt: string;
  /** Without its leading slash, so `/pr` and `pr` are one command. */
  command: string;
  args: string | null;
  mode: string | null;
  fixture: { branch: string | null; sha: string | null } | null;
  scenario: string | null;
  rubric: string | null;
  versions: Record<AbSide, AbVersion>;
  runs: Record<AbSide, AbRun>;
  judge: {
    /** Which arm the judge read as its first output. It never saw the letters. */
    shownFirst: AbSide | null;
    verdict: AbChoice | null;
    confidence: string | null;
    reasons: string[];
  };
  /** The person's pick, null when they recorded none. */
  pick: AbChoice | null;
  pickBy: string | null;
}

function side(value: JsonInput): AbSide | null {
  const text = jsonString(value);
  return text === 'a' || text === 'b' ? text : null;
}

function choice(value: JsonInput): AbChoice | null {
  return jsonString(value) === 'tie' ? 'tie' : side(value);
}

function str(value: JsonInput): string | null {
  return jsonString(value) ?? null;
}

function num(value: JsonInput): number | null {
  return jsonNumber(value) ?? null;
}

/**
 * A PR reference as one line of text. The trial writes whatever its arm reported, so a
 * bare number, a URL string and an object carrying either are all accepted.
 */
function prs(value: JsonInput): string[] {
  const out: string[] = [];
  for (const entry of jsonArray(value) ?? []) {
    const url = jsonString(entry) ?? stringField(entry, 'url');
    const number = jsonNumber(entry) ?? numberField(entry, 'number');
    if (url !== undefined) out.push(url);
    else if (number !== undefined) out.push(`#${number}`);
  }
  return out;
}

function readRun(value: JsonInput): AbRun {
  const run = jsonObject(value);
  return {
    output: str(run?.output),
    title: str(run?.title),
    toolUses: num(run?.toolUses),
    tokens: num(run?.tokens),
    durationMs: num(run?.durationMs),
    refusals: num(run?.refusals),
    refusalLines: stringArrayField(run, 'refusalLines'),
    close: str(run?.close),
    closeReason: str(run?.closeReason),
    skipped: stringArrayField(run, 'skipped'),
    prAction: str(run?.prAction),
    prs: prs(run?.prs),
    diff: str(run?.diff),
  };
}

function readVersion(value: JsonInput): AbVersion {
  const version = jsonObject(value);
  return { ref: str(version?.ref), lines: num(version?.lines) };
}

/** A scenario is written as a bare name or as an object naming itself. */
function scenarioName(value: JsonInput): string | null {
  return jsonString(value) ?? stringField(value, 'name') ?? stringField(value, 'id') ?? null;
}

/** The trial a keep record carries, or null when the record is not an `/ab` trial label. */
export function readAbTrial(record: JsonInput): AbTrial | null {
  if (stringField(record, 'kind') !== 'ab') return null;
  const trial = objectField(record, 'trial');
  const command = stringField(trial, 'command')?.replace(/^\/+/, '');
  if (!trial || !command) return null;

  const fixture = objectField(trial, 'fixture');
  const versions = objectField(trial, 'versions');
  const runs = objectField(trial, 'runs');
  const judge = objectField(trial, 'judge');
  const label = objectField(record, 'label');

  return {
    recordedAt: stringField(record, 'recordedAt') ?? stringField(record, 'startedAt') ?? '',
    command,
    args: str(trial.args) || null,
    mode: str(trial.mode),
    fixture: fixture ? { branch: str(fixture.branch), sha: str(fixture.sha) } : null,
    scenario: scenarioName(trial.scenario),
    rubric: str(trial.rubric),
    versions: { a: readVersion(versions?.a), b: readVersion(versions?.b) },
    runs: { a: readRun(runs?.a), b: readRun(runs?.b) },
    judge: {
      shownFirst: side(judge?.shownFirst),
      verdict: choice(judge?.verdict),
      confidence: str(judge?.confidence),
      reasons: stringArrayField(judge, 'reasons'),
    },
    // The label is the recorder's reading of the pick; the trial's own field is the fallback.
    pick: choice(label?.pick) ?? choice(trial.pick),
    pickBy: str(label?.by),
  };
}

/** Whether the person's pick matched the judge. Null when either side gave no answer. */
export function pickAgrees(pick: AbChoice | null, verdict: AbChoice | null): boolean | null {
  if (pick === null || verdict === null) return null;
  return pick === verdict;
}

/** What a trial ran from: the scenario's name, or the fixture branch. */
export function trialSetup(trial: AbTrial): string | null {
  return trial.scenario ?? trial.fixture?.branch ?? null;
}
