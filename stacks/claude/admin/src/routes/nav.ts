import type { LucideIcon } from 'lucide-react';

/**
 * The side rail's sections, in the order they are rendered. A page's `nav.section` names
 * the one it joins; within a section, stations follow `routes/registry.ts` module order.
 *
 * A section labels its stations; it is never a destination.
 */
export const NAV_SECTION_ORDER = ['Dashboard', 'Context', 'Sessions', 'Activity', 'Device', 'Learning'] as const;

export type NavSection = (typeof NAV_SECTION_ORDER)[number];

/**
 * One station in the side rail, exported as `nav` beside the `route` it points at. A page
 * that belongs in no section exports no `nav` at all.
 *
 * Declare one with `as const satisfies NavEntry`, never `: NavEntry` — the annotation
 * widens `to` to `string` and `<Link to>` stops rejecting a bad path.
 */
export interface NavEntry {
  section: NavSection;
  to: string;
  label: string;
  /** The dimmed word after the label. */
  hint: string;
  /** Whether only an exact pathname lights the station. */
  exact: boolean;
  icon: LucideIcon;
}
