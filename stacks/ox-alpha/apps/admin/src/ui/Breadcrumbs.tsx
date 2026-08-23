import { Fragment } from 'react';

// Drill-down navigation between related views (`components/Breadcrumbs.tsx`
// at the pinned commit). Rendered as an ordered list so the hierarchy reads
// to assistive tech; the last crumb is the current location.

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
}

export function Breadcrumbs({ crumbs }: { readonly crumbs: readonly Breadcrumb[] }) {
  return (
    <nav className='breadcrumbs' aria-label='Breadcrumb' data-testid='breadcrumbs'>
      <ol>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 && (
              <li aria-hidden='true' className='breadcrumb-sep'>
                /
              </li>
            )}
            <li>
              {crumb.href && index < crumbs.length - 1 ? (
                <a href={crumb.href}>{crumb.label}</a>
              ) : (
                <span aria-current='page'>{crumb.label}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
