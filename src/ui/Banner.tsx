import type { JSX, ReactNode } from "react";

import { copy } from "../copy/en.ts";

/** A quiet line above the page: how the places loaded, or that the browser is offline. */
export function Banner({ children }: { children: ReactNode }): JSX.Element {
  return <p className="m-0 rounded-card bg-surface px-4 py-3 text-secondary leading-[1.4] text-ink-soft">{children}</p>;
}

/**
 * A message that takes the page's place, with what the person can do about it. `alert` is for
 * something gone wrong, which a screen reader announces as it appears.
 */
export function PageMessage({
  children,
  action,
  alert = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  alert?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-gutter-phone py-16 text-center wide:px-gutter-desktop">
      <p role={alert ? "alert" : "status"} className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">
        {children}
      </p>
      {action}
    </div>
  );
}

/** The main button on a page: accent, 52 px tall (DeskReview.dc.html, Place.dc.html). */
export const primaryButton =
  "inline-flex h-13 cursor-pointer items-center justify-center rounded-button border-0 bg-accent-solid px-7 font-text text-body font-bold text-on-accent no-underline";

/** The places could not be loaded: said as an alert, with Try again. */
export function LoadFailed({ retry }: { retry(): void }): JSX.Element {
  return (
    <PageMessage
      alert
      action={
        <button type="button" onClick={retry} className={primaryButton}>
          {copy.load.retry}
        </button>
      }
    >
      {copy.load.failed}
    </PageMessage>
  );
}
