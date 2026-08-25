import type { SessionNode } from '@agent-proxy/claude-core';
import { isAgentSpawn, spawnAgentType } from '@agent-proxy/claude-core';
import type { SessionGraphEntry } from './api';
import type { CommandRunSpan } from './graph-commands';
import { commandRuns } from './graph-commands';

/**
 * The agent grain's projection: one box per agent the run dispatched, every turn between the
 * dispatches folded away. A pure projection over one transcript — a spawn step names its own
 * `subagent_type`, so nothing outside the transcript is needed.
 *
 * It keeps the *spawn* step rather than inventing a node, and two things follow. The engine's
 * branch band is placed against the index that spawned it, so the family tree stays drawn.
 * And a spawn whose transcript was never linked still draws; {@link AgentFacts.linked} is
 * where the drawer says so.
 */
export const projectAgents = (entry: SessionGraphEntry): SessionNode[] => entry.nodes.filter(isAgentSpawn);

/** What one agent box stands for: the dispatch, the transcript behind it, and what it did. */
export interface AgentFacts {
  /** Index of the spawn step in the *parent* transcript — the key the box is found by. */
  spawnIndex: number;
  /** The `subagent_type` the dispatch named, or `subagent` when it recorded none. */
  agentType: string;
  /** The agent's own transcript, when one was captured and linked to this spawn. */
  child: SessionGraphEntry | null;
  /** False when the spawn has no transcript — dispatched, but nothing to fold. */
  linked: boolean;
  /** The turns folded inside this box, in order. Empty when unlinked. */
  turns: SessionNode[];
  /** The command runs this agent opened, so the drawer can link down into the command view. */
  runs: CommandRunSpan[];
  tools: number;
  errors: number;
  /** Agents this agent dispatched in turn — its own boxes at this grain. */
  agents: number;
  /** The parent hasn't stepped past the dispatch, so nothing has come back yet. */
  inFlight: boolean;
}

/** How an agent box reads: the type it was dispatched as. */
export const agentLabel = (facts: AgentFacts): string => facts.agentType || 'subagent';

/** The type a spawn step names, normalised the way a box shows it. */
export const spawnLabel = (node: SessionNode): string => spawnAgentType(node) || 'subagent';

/**
 * Every agent in the family, keyed parent thread → spawn index, so a placed box finds what it
 * folded. Built from the same links the rail nests by: a transcript records the parent it was
 * spawned from and the step it was spawned at.
 */
export function indexAgents(
  entries: readonly SessionGraphEntry[],
  isCommand: (name: string) => boolean,
): Map<string, Map<number, AgentFacts>> {
  const childAt = new Map<string, SessionGraphEntry>();
  const childCount = new Map<string, number>();
  for (const child of entries) {
    if (child.parentThreadId === null || child.spawnIndex === null) continue;
    childAt.set(`${child.parentThreadId}:${child.spawnIndex}`, child);
    childCount.set(child.parentThreadId, (childCount.get(child.parentThreadId) ?? 0) + 1);
  }

  const index = new Map<string, Map<number, AgentFacts>>();
  for (const entry of entries) {
    const bySpawn = new Map<number, AgentFacts>();
    for (const node of entry.nodes) {
      if (!isAgentSpawn(node)) continue;
      const child = childAt.get(`${entry.threadId}:${node.index}`) ?? null;
      bySpawn.set(node.index, {
        spawnIndex: node.index,
        agentType: child?.agentType || spawnLabel(node),
        child,
        linked: child !== null,
        turns: child?.nodes ?? [],
        runs: child ? commandRuns(child, isCommand) : [],
        tools: child?.nodes.filter((n) => n.type === 'tool').length ?? 0,
        errors: child?.nodes.filter((n) => n.type === 'error').length ?? 0,
        agents: child ? (childCount.get(child.threadId) ?? 0) : 0,
        inFlight: child !== null && child.returnIndex === null,
      });
    }
    if (bySpawn.size > 0) index.set(entry.threadId, bySpawn);
  }
  return index;
}
