import { Children, Fragment, type ReactNode } from "react";

/**
 * Trail shown above a drilled-down page's title. Pass each ancestor as a
 * `<Link className="link">` and the current page as a `<span className="crumb-current">`;
 * this component interleaves the `›` separators and frames them as a nav landmark.
 */
export function Breadcrumbs({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="crumb-sep" aria-hidden>
              ›
            </span>
          )}
          {child}
        </Fragment>
      ))}
    </nav>
  );
}
