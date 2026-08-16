import type { SessionNode } from '@claude-proxy/core';
import { isAgentSpawn, spawnAgentType } from '@claude-proxy/core';
import type { SessionGraphEntry } from './api';
import type { CommandRunSpan } from './graph-commands';
import { commandRuns } from './graph-commands';

/**
 * The agent grain's projection: one box per agent the run dispatched, with every turn between
 * the dispatches folded away.
 *
 * It is a **pure projection** over one transcript, like the command grain — a spawn step is
 * recognisable from the node itself (`Agent(…)` / `Task(…)` carries a `subagent_type`), so the
 * grain needs neither the family index nor the engine's help to answer which steps it keeps.
 *
 * Two consequences of keeping the *spawn* step rather than inventing a node are worth stating,
 * because they are what makes this a projection instead of an engine change:
 *
 * - **The engine's branch band still frames each agent.** A band is placed against the node
 *   index that spawned it, so keeping the spawn step is exactly what keeps the family tree
 *   drawn — the parent's snake becomes agent-only, and each agent's own snake (recursively at
 *   this grain) is the agents *it* dispatched.
 * - **A spawn whose transcript was never linked still draws.** The step says an agent was
 *   dispatched; whether a transcript for it survives is a separate question, and {@link
 *   AgentFacts.linked} is where the drawer says so rather than the box vanishing.
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
