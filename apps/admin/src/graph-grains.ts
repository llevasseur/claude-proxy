import type { SessionNode } from '@claude-proxy/core';
import type { SessionGraphEntry } from './api';

/**
 * How coarse the live graph draws — the "grain" the layout engine is asked for.
 *
 * A grain is a **projection**: given one transcript, it answers the node set that grain
 * draws for it. The engine takes that set and knows nothing else about the grain, so a
 * coarser view is a new projection here rather than a second layout pass.
 *
 * Only `turn` is built. `command` and `agent` are registered so the control lists what the
 * page is heading towards and a later view registers itself by supplying a `project` —
 * they render disabled until then rather than pretending to be a view that exists.
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

/** Every grain the control offers, coarsest last. */
export const GRAINS: readonly GrainSpec[] = [
  TURN_GRAIN,
  { id: 'command', label: 'Command', hint: 'One box per command the run invoked' },
  { id: 'agent', label: 'Agent', hint: 'One box per agent in the family' },
];

export const grainById = (id: GrainId): GrainSpec => GRAINS.find((g) => g.id === id) ?? TURN_GRAIN;
