import type { SessionNode } from '@agent-proxy/claude-core';
import type { SessionGraphEntry } from './api';
import { projectAgents } from './graph-agents';
import { projectCommandRuns } from './graph-commands';

/**
 * How coarse the live graph draws — the "grain" the layout engine is asked for.
 *
 * A grain is a **projection**: given one transcript, it answers the node set that grain
 * draws for it. The engine takes that set and knows nothing else about the grain, so a
 * coarser view is a new projection here rather than a second layout pass.
 *
 * `turn`, `command` and `agent` are all built. A grain registered without a `project` renders
 * disabled; that is the seam a later view arrives through.
 */
export type GrainId = 'turn' | 'command' | 'agent';

export interface GrainSpec {
  id: GrainId;
  label: string;
  /** What this grain draws, as the control's tooltip says it. */
  hint: string;
  /**
   * One transcript's steps at this grain. Absent means registered but not built yet —
   * {@link isBuilt} is the narrowing the engine's input requires.
   */
  project?: (entry: SessionGraphEntry) => SessionNode[];
}

/** A grain that can actually be drawn: the engine takes only these. */
export interface BuiltGrain extends GrainSpec {
  project: NonNullable<GrainSpec['project']>;
}

export const isBuilt = (grain: GrainSpec): grain is BuiltGrain => grain.project !== undefined;

/** The finest grain, and the one the page has always drawn: every step the transcript kept. */
export const TURN_GRAIN: BuiltGrain = {
  id: 'turn',
  label: 'Turn',
  hint: 'Every step the transcript recorded',
  project: (entry) => entry.nodes,
};

/**
 * One box per command run rather than per turn.
 *
 * Which names open a run is a question about what is *installed*, not about the transcript, so
 * the grain is a factory: the page binds the installed catalogue and hands the engine the bound
 * grain. {@link COMMAND_GRAIN} is what the registry holds, bound to no catalogue — it treats
 * every `Skill(…)` call as a run, which is what the view degrades to for the moment before the
 * catalogue arrives, and is why the control's pill is enabled from the first paint.
 */
export const commandGrain = (isCommand: (name: string) => boolean): BuiltGrain => ({
  id: 'command',
  label: 'Command',
  hint: 'One box per command the run invoked',
  project: (entry) => projectCommandRuns(entry, isCommand),
});

export const COMMAND_GRAIN: BuiltGrain = commandGrain(() => true);

/**
 * The coarsest grain: one box per agent the run dispatched, every turn between the dispatches
 * folded away. Nothing is bound to it — a spawn step names its own `subagent_type`.
 */
export const AGENT_GRAIN: BuiltGrain = {
  id: 'agent',
  label: 'Agent',
  hint: 'One box per agent in the family',
  project: projectAgents,
};

/** Every grain the control offers, coarsest last. */
export const GRAINS: readonly GrainSpec[] = [TURN_GRAIN, COMMAND_GRAIN, AGENT_GRAIN];

export const grainById = (id: GrainId): GrainSpec => GRAINS.find((g) => g.id === id) ?? TURN_GRAIN;
