import type { UnavailableNotice } from '@agent-proxy/claude-core';
import { useId } from 'react';

/**
 * The mark that stands where a value would have stood, when the dashboard does
 * not know the value.
 *
 * [ADR 0020](../../../../../docs/adrs/0020-unavailable-incomplete-cost.md) and
 * [ADR 0044](../../../../../docs/adrs/0044-every-model-gets-a-price-row.md)
 * refuse to render an unknown cost as `$0` or as an empty cell, because both
 * look like a measurement: a zero aggregates and understates spend, and a blank
 * reads as nothing having happened. So this is deliberately neither a number nor
 * an absence — a hollow, dashed pill carrying the reason's own short label, with
 * the sentence a hover or a focus away.
 *
 * **It renders a store's absence too**, not only a cost's. Core's
 * `UnavailableNotice` projects both unions onto one record precisely so there is
 * one visual language for "we do not know" rather than a second dialect invented
 * for the second kind of absence.
 *
 * The metrics beside it are untouched. ADR 0020 returns the complete token
 * counts and marks only the *cost* unavailable, so this must not read as "this
 * row is broken" — which is why the detail lives in a bubble rather than in a
 * caption that would change the height of the unpriced rows alone.
 */
export interface UnavailableProps {
  notice: UnavailableNotice;
  /** `lg` for a stat headline, `sm` (the default) for a table cell or a list row. */
  size?: 'sm' | 'lg';
  /** Open the note inward, for a right-aligned numeric cell. */
  alignEnd?: boolean;
}

export function Unavailable({ notice, size = 'sm', alignEnd = false }: UnavailableProps) {
  const id = useId();
  const classes = ['unavailable', `sev-${notice.severity}`];
  if (size === 'lg') classes.push('size-lg');
  if (alignEnd) classes.push('align-end');
  const label = (
    <>
      <span className='sr-only'>{notice.kind === 'cost' ? 'Cost unavailable: ' : 'Data unavailable: '}</span>
      {notice.label}
    </>
  );

  // In a stat headline the pill is **not** interactive, and that is a constraint
  // rather than a preference: `StatCard` wraps its body in a `Link` whenever the
  // tile names a metric, and every metric does — so a button here would be
  // interactive content nested in an anchor. Invalid HTML, a second tab stop on
  // every money tile, and a click on the mark navigating away instead of
  // explaining itself. The sentence is not lost: the tile carries it on its own
  // sub line, and `title` gives it to a pointer the way `RateStamp` beside it
  // already does.
  if (size === 'lg') {
    return (
      <span className={classes.join(' ')} data-code={notice.code}>
        <span className='unavailable-pill' title={notice.detail}>
          {label}
        </span>
      </span>
    );
  }

  return (
    <span className={classes.join(' ')} data-code={notice.code}>
      {/* A button rather than a span: the sentence has to be reachable from the
          keyboard, and a hover-only note is not. Nothing in the sheet keys on the
          element, so a later ticket can swap this for a link to the pricing page
          without touching the CSS. */}
      <button type='button' className='unavailable-pill' aria-describedby={id}>
        {label}
      </button>
      <span id={id} role='tooltip' className='hint-bubble unavailable-bubble'>
        {notice.detail}
      </span>
    </span>
  );
}
