import type { LucideIcon } from 'lucide-react';

/**
 * The side rail's sections, in the order they are rendered.
 *
 * A flat registry cannot encode ordering or grouping, so the two survive here rather
 * than in the page files: this list is the section order, and a page's `nav.section`
 * names which one it joins. Within a section, stations appear in the order
 * `routes/registry.ts` lists their modules — so both orderings are read off a single
 * short list each, instead of being restated per page.
 *
 * A section labels its stations; it is never a destination.
 */
export const NAV_SECTION_ORDER = ['Dashboard', 'Context', 'Sessions', 'Activity', 'Device', 'Learning'] as const;

export type NavSection = (typeof NAV_SECTION_ORDER)[number];

/**
 * One station in the side rail, exported as `nav` beside the `route` it points at.
 *
 * A page that belongs in no section exports no `nav` at all — absence is how "not in
 * the rail" is spelled, which is why every field here is required.
 *
 * Declare one with `as const satisfies NavEntry`, never `: NavEntry`. The annotation
 * would widen `to` to `string` and `<Link to>` would stop rejecting a bad path; the
 * `as const` keeps the literal and `satisfies` still checks the shape.
 */
export interface NavEntry {
  /** Which section of {@link NAV_SECTION_ORDER} this station appears under. */
  section: NavSection;
  /** The path to navigate to — the route's own `path`, typed as a literal. */
  to: string;
  /** Station text. */
  label: string;
  /** The dimmed word after the label. */
  hint: string;
  /** Whether only an exact pathname lights the station. `/trends` is not exact, so `/trends/$metric` keeps it lit. */
  exact: boolean;
  icon: LucideIcon;
}
