import { Children, Fragment, type ReactNode } from "react";

/** Trail above a drilled-down page's title: pass ancestors as `<Link className="link">` and the current page as `<span className="crumb-current">`. */
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
