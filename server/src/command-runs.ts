/**
 * The command-run store and the pass that fills it.
 *
 * **Why a store at all.** Everything a run is made of expires. Transcripts and
 * `.request.txt` bodies live in `logs/` for roughly a day; only sidecars are archived
 * (`rawArchiveDayDir`), and archived days get pruned. So a run that isn't distilled
 * while its raw material is still on disk can never be reconstructed. This module
 * writes that distillation to `logs/commands/runs.jsonl` — append-only, versioned, one
 * JSON record per line — and the Commands page reads only the store.
 *
 * **The pass is idempotent.** {@link reconcileCommandRuns} is keyed by thread id and
 * upserts, so it is safe to run on every log-directory change (which is what keeps the
 * page live mid-run) and again from the daily-summary job as a backstop before the raw
 * logs age out. Same code path both times. Turns already recorded are never re-read,
 * so a steady-state pass opens only the request bodies that have appeared since.
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type AuditSidecar,
  addTokens,
  analyzeRequestBody,
  attributeSteps,
  COMMAND_RUN_SCHEMA,
  type CommandRun,
  type CommandRunTurn,
  type CommandStep,
  classifyOutcome,
  contentHash,
  deriveSessionNodes,
  detectPatterns,
  reachedEnd as didReachEnd,
  estimateCost,
  findNestedInvocations,
  type InterruptionKind,
  isAuditSidecar,
  isCommandRun,
  nestedRunId,
  parseCommandEnvelope,
  parseCommandSteps,
  reportDay,
  runKey,
  type SessionNode,
  summarizeSteps,
  ZERO_TOKENS,
} from '@claude-proxy/core';
import { readRequestBodyParsed, readSidecars } from './logs.js';
import { listSessionGraphs, resolveSessionsDir, type SessionGraph, threadIdForBody } from './sessions.js';

/** Where the CLI installs user commands. `COMMANDS_DIR` overrides it, for tests. */
export function resolveCommandsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDS_DIR ? path.resolve(env.COMMANDS_DIR) : path.join(os.homedir(), '.claude', 'commands');
}

/** The append-only run store. */
export function commandStorePath(logDir: string): string {
  return path.join(logDir, 'commands', 'runs.jsonl');
}

/** The request index — see {@link RequestIndex}. */
export function requestIndexPath(logDir: string): string {
  return path.join(logDir, 'commands', 'requests.json');
}

/** What one captured request body told us, once, so it never has to be opened again. */
export interface RequestFacts {
  /** The thread that sent it, hashed back from the body. Null when it had no user text. */
  threadId: string | null;
  /** How many nodes the run had produced by the time this request went out. */
  nodeCount: number;
  messageCount: number;
}

/**
 * A durable map from captured-request file to what its body said, keyed by sidecar
 * stem.
 *
 * This is what makes the reconcile pass incremental rather than quadratic: a body is
 * opened at most once, ever, whether or not it turned out to belong to a command run.
 *
 * It also outlives the bodies. `.request.txt` files rotate out within a day, so an entry
 * recorded while the body existed is the only remaining way to place that request's
 * tokens against a step.
 */
export interface RequestIndex {
  schema: number;
  entries: Record<string, RequestFacts>;
}

const REQUEST_INDEX_SCHEMA = 1;

/** Read the request index, tolerating absence, corruption and a foreign schema. */
export async function readRequestIndex(logDir: string): Promise<RequestIndex> {
  try {
    const parsed = JSON.parse(await readFile(requestIndexPath(logDir), 'utf8')) as RequestIndex;
    if (parsed?.schema !== REQUEST_INDEX_SCHEMA || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { schema: REQUEST_INDEX_SCHEMA, entries: {} }; // rebuilt from scratch, which is safe
    }
    return { schema: REQUEST_INDEX_SCHEMA, entries: parsed.entries };
  } catch {
    return { schema: REQUEST_INDEX_SCHEMA, entries: {} };
  }
}

/** Write the request index, creating `logs/commands/` on first write. */
export async function writeRequestIndex(logDir: string, index: RequestIndex): Promise<void> {
  const file = requestIndexPath(logDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(index), 'utf8');
}

/** One installed command file, parsed. */
export interface InstalledCommand {
  command: string;
  steps: CommandStep[];
  /** Content hash of the file as installed — the marker a `/sync` moves. */
  commandHash: string;
  /** The file's markdown, byte for byte — what the command page renders. */
  content: string;
}

/**
 * Every `*.md` in the commands directory, parsed into its step catalogue and hashed.
 * An unreadable directory yields an empty list rather than throwing: a machine with no
 * installed commands is a legitimate empty page, not an error.
 */
export async function listInstalledCommands(dir: string): Promise<InstalledCommand[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: InstalledCommand[] = [];
  for (const name of names.filter((f) => f.endsWith('.md'))) {
    try {
      const content = await readFile(path.join(dir, name), 'utf8');
      out.push({
        command: name.replace(/\.md$/, '').toLowerCase(),
        steps: parseCommandSteps(content),
        commandHash: contentHash(content),
        content,
      });
    } catch {
      // A file that vanished mid-scan simply isn't installed.
    }
  }
  return out.sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Read the store, newest record per run id winning.
 *
 * Keying on {@link runKey} rather than the thread id lets a nested run share its host's
 * session without colliding with it, and leaves older records keyed as they were.
 *
 * Every layer here is tolerant, because the file is append-only and long-lived: a line
 * that doesn't parse is skipped, and a record from a different schema version is
 * **kept** — {@link isCommandRun} checks only the identity fields, so a version bump
 * degrades the page's detail rather than emptying it. A missing store reads as empty.
 */
export async function readCommandRuns(logDir: string): Promise<CommandRun[]> {
  return (await readCommandRunRecords(logDir)).filter((run) => !run.retired);
}

/**
 * Every record the store holds, **retired ones included** — {@link readCommandRuns} is the
 * view the page reads. A retired record is still the only surviving evidence of its run's
 * turns, so reconciliation carries it forward.
 */
async function readCommandRunRecords(logDir: string): Promise<CommandRun[]> {
  let text: string;
  try {
    text = await readFile(commandStorePath(logDir), 'utf8');
  } catch {
    return []; // nothing recorded yet — an empty page, not an error
  }
  return sortCommandRuns(parseCommandRunStore(text));
}

/**
 * The store's text as the newest record per {@link runKey}, **in first-appearance
 * order** — a `Map` keeps the position a key was first inserted at, so a later
 * line supersedes an earlier one's contents without moving it.
 *
 * That order is load-bearing: {@link sortCommandRuns} sorts on `started` alone
 * and `Array.prototype.sort` is stable, so first appearance breaks ties. The
 * substrate stores it as `command_run.ord` to reproduce the same listing.
 */
export function parseCommandRunStore(text: string): CommandRun[] {
  const byKey = new Map<string, CommandRun>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn final line from an interrupted append
    }
    if (!isCommandRun(parsed)) continue;
    byKey.set(runKey(parsed), parsed); // later line supersedes earlier
  }
  return [...byKey.values()];
}

/** Newest run first. Stable, so records with equal `started` keep store order. */
export function sortCommandRuns(runs: CommandRun[]): CommandRun[] {
  return runs.sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''));
}

/** Append records to the store, creating `logs/commands/` on first write. */
export async function appendCommandRuns(logDir: string, runs: readonly CommandRun[]): Promise<void> {
  if (runs.length === 0) return;
  const file = commandStorePath(logDir);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/**
 * Request bodies opened per pass. Each body is opened at most once ever — the index
 * remembers the rest — so this only bounds the first pass over a fresh log window, and
 * whatever it leaves is picked up by the next pass.
 */
const MAX_NEW_REQUEST_READS = 500;

/** A transcript still being appended to is a run still going. */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * A root prompt that was actually read, versus one there is no evidence either way about.
 * A sidecar that is missing, torn, or carries no `root` — the proxy records one only once it
 * has a prompt to record — says nothing, and only a prompt we hold can retire a record.
 */
type RootPrompt = { read: true; prompt: string } | { read: false };

/** A run's opening prompt: the transcript's `.state.json` holds it untruncated. */
async function readRootPrompt(logDir: string, threadId: string): Promise<RootPrompt> {
  try {
    const raw = await readFile(path.join(resolveSessionsDir(logDir), `${threadId}.state.json`), 'utf8');
    const state = JSON.parse(raw) as { root?: unknown };
    return typeof state.root === 'string' ? { read: true, prompt: state.root } : { read: false };
  } catch {
    return { read: false }; // no sidecar, or it went away
  }
}

/** The sidecar's own file stem, attached by `readSidecars({ includeFile: true })`. */
function sidecarFile(sidecar: AuditSidecar): string | null {
  const file = (sidecar as { __file?: unknown }).__file;
  return typeof file === 'string' ? file : null;
}

export interface ReconcileResult {
  /** Records written this pass. */
  written: number;
  /** Runs the store holds afterwards. */
  runs: number;
  /** Request bodies opened this pass. */
  requestsRead: number;
  /** True when the read cap stopped the pass short — the next one picks up the rest. */
  capped: boolean;
}

/** What a record says it is, before its transcript and turns are read. */
interface RunIdentity {
  /** The store key — see {@link runKey}. */
  runId: string;
  parentRunId: string | null;
  parentCommand: string | null;
  spawnNode: number | null;
  /** The host nodes this run covers, or null for the whole transcript. */
  range: { from: number; to: number } | null;
  command: string;
  args: string;
  flags: string[];
  prompt: string;
}

/**
 * Distil every command run visible in the log directory into the store.
 *
 * Keyed by run id and upsert-only, so re-running is safe and cheap: a record's turns
 * are reused wholesale, and only request bodies that have appeared since the last pass
 * are opened. A run is rewritten whenever its transcript has grown, which is what lets
 * the page follow a run as it happens.
 */
export async function reconcileCommandRuns(
  logDir: string,
  commandsDir: string = resolveCommandsDir(),
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const [graphs, installed, records, index] = await Promise.all([
    listSessionGraphs(logDir),
    listInstalledCommands(commandsDir),
    readCommandRunRecords(logDir),
    readRequestIndex(logDir),
  ]);

  // Retirement reads the live view, so a record already retired is never retired twice.
  // Carry-forward reads every record, retired or not: a thread that parses as a run again
  // keeps its turns instead of starting over from whatever sidecars still exist.
  const existing = records.filter((run) => !run.retired);
  const byThread = new Map(graphs.map((g) => [g.threadId, g]));
  const byCommand = new Map(installed.map((c) => [c.command, c]));
  const priorByKey = new Map(records.map((r) => [runKey(r), r]));
  const liveKeys = new Set(existing.map(runKey));

  // A run is any session whose opening prompt carries the command envelope, and any
  // command that session invokes inside itself. A nested one is a *slice* of its
  // parent's transcript rather than a separate one, so it is a run in its own right and
  // still rolls up — both readings are wanted, and they agree rather than double-count.
  const targets: { graph: SessionGraph; identity: RunIdentity }[] = [];
  const judged = new Set<string>();
  for (const graph of graphs) {
    const root = await readRootPrompt(logDir, graph.threadId);
    if (!root.read) continue; // no prompt to judge by — leave whatever is on record alone
    judged.add(graph.threadId);
    const envelope = parseCommandEnvelope(root.prompt);
    if (!envelope) continue;
    targets.push({
      graph,
      identity: {
        runId: graph.threadId,
        parentRunId: null,
        parentCommand: null,
        spawnNode: null,
        range: null,
        command: envelope.command,
        args: envelope.args,
        flags: envelope.flags,
        prompt: envelope.prompt,
      },
    });
    for (const nested of findNestedInvocations(graph.nodes, (name) => byCommand.has(name))) {
      targets.push({
        graph,
        identity: {
          runId: nestedRunId(graph.threadId, nested.from),
          parentRunId: graph.threadId,
          parentCommand: envelope.command,
          spawnNode: nested.from,
          range: { from: nested.from, to: nested.to },
          command: nested.command,
          // No envelope survives a nested call, so there is nothing to record here.
          args: '',
          flags: [],
          prompt: '',
        },
      });
    }
  }

  // Records whose opening prompt we still hold and it no longer reads as a run — what an
  // earlier parse leaves behind. A transcript whose `.state.json` is gone is absence of
  // evidence, not evidence the run never happened. Keyed on the run rather than the
  // thread, so a nested run whose `Skill` call is no longer in its host's transcript
  // retracts on the same terms as a top-level one. Retired before the early return, so a
  // log window with no runs left still retracts them.
  const targetKeys = new Set(targets.map((t) => t.identity.runId));
  const retired = existing
    .filter((run) => judged.has(run.threadId) && !targetKeys.has(runKey(run)))
    .map((run): CommandRun => ({ ...run, retired: true, updatedAt: now.toISOString() }));
  if (retired.length > 0) await appendCommandRuns(logDir, retired);

  if (targets.length === 0) {
    return { written: retired.length, runs: liveKeys.size - retired.length, requestsRead: 0, capped: false };
  }

  // One sidecar sweep for every run, from the earliest run's reporting day, narrowed to
  // the session ids the runs and their subagents were captured under. The session id is
  // on the sidecar, so this rules out most of the day's requests before any body opens.
  // Nested runs share their host's sessions, so the sweep is the hosts', deduped.
  const hosts = [...new Map(targets.map((t) => [t.graph.threadId, t.graph])).values()];
  const runSessionIds = new Set<string>();
  for (const graph of hosts) {
    for (const threadId of familyOf(graph.threadId, byThread)) {
      const sessionId = byThread.get(threadId)?.sessionId;
      if (sessionId) runSessionIds.add(sessionId);
    }
  }

  const starts = hosts
    .map((g) => g.started)
    .filter((s): s is string => !!s)
    .sort();
  const since = (starts[0] && reportDay(starts[0])) || undefined;
  const { sidecars } = await readSidecars(logDir, { since, includeFile: true }, now);
  const audits = sidecars
    .filter(isAuditSidecar)
    .filter((s) => sidecarFile(s) !== null && s.session?.sessionId && runSessionIds.has(s.session.sessionId));

  // Open only bodies the index has never seen. Newest first, so a live run's latest
  // turns land first if the cap bites.
  const pending = audits
    .filter((s) => !(sidecarFile(s)! in index.entries))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  let requestsRead = 0;
  for (const sidecar of pending) {
    if (requestsRead >= MAX_NEW_REQUEST_READS) break;
    const file = sidecarFile(sidecar)!;
    let body: unknown;
    try {
      body = await readRequestBodyParsed(logDir, file);
    } catch {
      continue; // rotated away before we got to it — its tokens stay unplaced
    }
    requestsRead += 1;
    const messages = (body as { messages?: unknown } | null)?.messages;
    index.entries[file] = {
      threadId: threadIdForBody(sidecar.session?.sessionId ?? null, messages),
      nodeCount: deriveSessionNodes(body).length,
      messageCount: analyzeRequestBody(body).messageCount,
    };
  }
  if (requestsRead > 0) await writeRequestIndex(logDir, index);

  // Build a record per run and append the ones that changed.
  const written: CommandRun[] = [];
  for (const { graph, identity } of targets) {
    const spec = byCommand.get(identity.command);
    // Prefer the installed catalogue; fall back to whatever this run recorded before, so
    // a command uninstalled since capture still renders against the steps it ran under.
    const prior = priorByKey.get(identity.runId);
    const steps = spec?.steps ?? prior?.steps ?? [];

    const run = buildRun({
      graph,
      identity,
      steps,
      commandHash: spec?.commandHash ?? prior?.commandHash ?? null,
      byThread,
      audits,
      index,
      prior,
      now,
    });

    // A record that says exactly what the last one said is not worth a line.
    if (prior && sameRun(prior, run)) continue;
    written.push(run);
  }

  await appendCommandRuns(logDir, written);
  const live = new Set([...liveKeys, ...written.map(runKey)]);
  for (const run of retired) live.delete(runKey(run));
  return {
    written: written.length + retired.length,
    runs: live.size,
    requestsRead,
    capped: pending.length > requestsRead,
  };
}

/** Everything about a record except when it was written. */
function sameRun(a: CommandRun, b: CommandRun): boolean {
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
}

/**
 * Assemble one run record from its family's transcripts and captured requests.
 *
 * A nested run is built by the same code against a slice of the same transcript:
 * `identity.range` narrows which nodes are the run's spine, which subagents belong to
 * it, and which of the host thread's turns it is charged. A top-level run has no range
 * and takes the lot.
 */
function buildRun(input: {
  graph: SessionGraph;
  identity: RunIdentity;
  steps: CommandStep[];
  commandHash: string | null;
  byThread: Map<string, SessionGraph>;
  audits: AuditSidecar[];
  index: RequestIndex;
  prior: CommandRun | undefined;
  now: Date;
}): CommandRun {
  const { graph, identity, steps, byThread, audits, index, prior, now } = input;
  const range = identity.range;

  /** Does a host node belong to this run? Always, when it covers the whole transcript. */
  const covers = (node: number | null): boolean =>
    range === null || (node !== null && node >= range.from && node < range.to);

  // The family: this session plus the subagents beneath it — for a nested run, only the
  // ones it spawned itself.
  const family = range ? nestedFamily(graph.threadId, byThread, range) : familyOf(graph.threadId, byThread);
  const familySet = new Set(family);

  // The transcript is the spine the declared steps are laid against — the run's slice of
  // it. The full stream stays in hand because a turn is placed by how many nodes the
  // *thread* had produced when it went out.
  const allNodes = graph.nodes;
  const nodes = range ? allNodes.filter((n) => covers(n.index)) : allNodes;
  const attributions = attributeSteps(nodes, steps);
  const stepOfNode = new Map(attributions.map((a) => [a.node, a.step]));

  // A subagent inherits the step that was current where its parent spawned it, so a
  // whole delegated branch is charged to the step that chose to delegate.
  const stepOfThread = new Map<string, string | null>([[graph.threadId, null]]);
  for (const threadId of family) {
    if (threadId === graph.threadId) continue;
    const link = byThread.get(threadId);
    const parent = link?.parentThreadId;
    const spawn = link?.spawnIndex;
    const inherited =
      parent === graph.threadId && spawn != null
        ? (stepOfNode.get(spawn) ?? null)
        : parent
          ? (stepOfThread.get(parent) ?? null)
          : null;
    stepOfThread.set(threadId, inherited);
  }

  // Turns: every captured request the family sent, placed against a step.
  //
  // Prior turns are carried forward wholesale and keyed by file. That is not just a
  // cache: sidecars are archived and then pruned, so once a request has aged out of the
  // sweep the record it produced is the only surviving evidence of those tokens. The
  // sweep can only ever add.
  const byFile = new Map<string, CommandRunTurn>();
  for (const turn of prior?.turns ?? []) byFile.set(turn.file, turn);

  for (const sidecar of audits) {
    const file = sidecarFile(sidecar)!;
    if (byFile.has(file)) continue;
    const fact = index.entries[file];
    if (!fact?.threadId || !familySet.has(fact.threadId)) continue;
    byFile.set(file, {
      file,
      timestamp: sidecar.timestamp,
      threadId: fact.threadId,
      step: null,
      node: null,
      tokens: sidecar.tokens,
      systemBytes: sidecar.request.systemBytes,
      toolsBytes: sidecar.request.toolsBytes,
      toolCount: sidecar.request.toolCount,
      messageCount: fact.messageCount,
    });
  }

  // Place every turn against a step, prior ones included: a mid-run pass sees a shorter
  // transcript than the next one, so attribution has to be redone rather than frozen at
  // whatever the first pass could see. A turn whose body has since been forgotten keeps
  // the placement it was last given.
  const turns = [...byFile.values()]
    .map((turn) => {
      const fact = index.entries[turn.file];
      if (!fact) return turn;
      // The step current when the request went out: for the root, the last node it had
      // produced by then; for a subagent, the step it was spawned under.
      if (turn.threadId === graph.threadId) {
        const node = fact.nodeCount > 0 ? Math.min(fact.nodeCount, allNodes.length) - 1 : null;
        return { ...turn, node, step: node === null ? null : (stepOfNode.get(node) ?? null) };
      }
      return {
        ...turn,
        node: byThread.get(turn.threadId)?.spawnIndex ?? turn.node,
        step: stepOfThread.get(turn.threadId) ?? null,
      };
    })
    // The host thread's turns are shared with every run in it, so a nested one keeps only
    // those issued inside its span. A subagent's turns are already its own.
    .filter((turn) => turn.threadId !== graph.threadId || covers(turn.node))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const turnsUnmapped = turns.filter((t) => t.step === null).length;

  // The model the run was priced under. A turn whose sidecar has aged out can't answer,
  // so fall back to what the last record settled on.
  const model = turns[0]?.file ? (audits.find((s) => sidecarFile(s) === turns[0]!.file)?.model ?? null) : null;
  const priced = model ?? prior?.model ?? graph.model ?? '';

  const tokens = turns.reduce((acc, t) => addTokens(acc, t.tokens), ZERO_TOKENS);
  const familyNodes = [
    ...nodes,
    ...family.filter((t) => t !== graph.threadId).flatMap((t) => byThread.get(t)?.nodes ?? []),
  ];
  const interruption = lastInterruption(familyNodes);
  const reached = didReachEnd(steps, attributions, nodes);
  const modified = graph.modified;
  // A nested run is only still going if it is the last one in a transcript still growing;
  // an earlier one ended the moment the next command opened.
  const active =
    !!modified &&
    now.getTime() - new Date(modified).getTime() < ACTIVE_WINDOW_MS &&
    (range === null || range.to === allNodes.length);

  // A transcript's own start and end bracket the whole session, so they answer for a
  // top-level run only. A nested run with no surviving turns has no times to give.
  const started = turns[0]?.timestamp ?? (range ? null : graph.started) ?? null;
  const ended = turns[turns.length - 1]?.timestamp ?? (range ? null : modified) ?? null;

  // A top-level run *is* its session, so its transcript brackets the whole thing. A nested
  // run is a slice of someone else's session and has no bracket of its own.
  const wallFrom = range ? started : (graph.started ?? started);
  const wallTo = range ? ended : (modified ?? ended);

  return {
    schema: COMMAND_RUN_SCHEMA,
    runId: identity.runId,
    parentRunId: identity.parentRunId,
    parentCommand: identity.parentCommand,
    spawnNode: identity.spawnNode,
    nodeRange: range,
    threadId: graph.threadId,
    command: identity.command,
    args: identity.args,
    flags: identity.flags,
    prompt: identity.prompt,
    commandHash: input.commandHash,
    steps,
    model: priced || null,
    started,
    ended,
    threadIds: family,
    totals: {
      tokens,
      cost: estimateCost(tokens, priced).total,
      turns: turns.length,
      toolCalls: familyNodes.filter((n) => n.type === 'tool').length,
      durationMs: spanMs(started, ended),
      wallMs: spanMs(wallFrom, wallTo),
    },
    turns,
    stepStats: summarizeSteps({ steps, nodes, attributions, turns, model: priced }),
    outcome: classifyOutcome({
      reachedEnd: reached,
      interruption,
      lastNodeType: nodes[nodes.length - 1]?.type ?? null,
      active,
    }),
    interruption,
    reachedEnd: reached,
    patterns: detectPatterns(
      nodes,
      attributions,
      turns.map((t, i) => ({ step: t.step, realInput: t.tokens.realInput, index: i, node: t.node })),
    ),
    meta: {
      turnsUnmapped,
      nodes: nodes.length,
      attributed: attributions.filter((a) => a.step !== null).length,
      anchored: attributions.filter((a) => a.confidence !== 'inferred' && a.step !== null).length,
    },
    updatedAt: now.toISOString(),
  };
}

/**
 * A run's whole thread family: the session itself plus every subagent beneath it, at any
 * depth, parents before children. Cycle-safe, since the links come off disk.
 */
function familyOf(threadId: string, byThread: Map<string, SessionGraph>): string[] {
  const family: string[] = [];
  const walk = (id: string) => {
    if (family.includes(id)) return;
    family.push(id);
    for (const kid of byThread.get(id)?.childThreadIds ?? []) walk(kid);
  };
  walk(threadId);
  return family;
}

/**
 * A nested run's thread family: its host session plus only the subagents spawned inside
 * its span, each with everything beneath it.
 */
function nestedFamily(
  threadId: string,
  byThread: Map<string, SessionGraph>,
  range: { from: number; to: number },
): string[] {
  const family = [threadId];
  const seen = new Set(family);
  for (const kid of byThread.get(threadId)?.childThreadIds ?? []) {
    const spawn = byThread.get(kid)?.spawnIndex;
    if (spawn == null || spawn < range.from || spawn >= range.to) continue;
    for (const id of familyOf(kid, byThread)) {
      if (seen.has(id)) continue;
      seen.add(id);
      family.push(id);
    }
  }
  return family;
}

/** Milliseconds between two timestamps, or 0 when either is missing or unparseable. Clamped at 0. */
function spanMs(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const span = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(span) ? Math.max(0, span) : 0;
}

/** The kind of the last interruption anywhere in the family, if it was interrupted at all. */
function lastInterruption(nodes: readonly SessionNode[]): InterruptionKind | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const kind = nodes[i]!.interruption;
    if (kind) return kind;
  }
  return null;
}
