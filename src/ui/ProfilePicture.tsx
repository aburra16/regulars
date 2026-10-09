import { type JSX, type ReactNode, useState } from "react";

import { isUnloadablePicture, noteUnloadablePicture } from "../shell/unloadablePictures.ts";

/**
 * A person's picture from their profile, filling the circle it is drawn in: the account button's
 * (src/shell/TopBar.tsx), and each reviewer's beside their review (src/place/Reviews.tsx). `address`
 * is the https address their profile gives (`shownPicture`); until it is known, when there is none,
 * or once it will not load, `fallback` stands in its place. A picture that will not load is noted
 * for the session (`noteUnloadablePicture`), and not asked for again wherever it is drawn next.
 *
 * Its `alt` is empty: the person's name is always beside it, or in the name of the button it fills.
 * Its ground shows while it loads, and the ring keeps the edge of a light or a dark picture in
 * either theme. `className` adds to it, such as a folded review's dimming.
 *
 * Privacy: the address comes only from the person's own signed profile, and names a server of their
 * choosing. The visitor's browser asks that server for it, lazily, once it is near the screen; the
 * server sees the visitor's IP address, their browser, and when; with no referrer, not which page.
 * Avi asked for reviewers' pictures knowing this (2026-10-09).
 */
export function ProfilePicture({
  address,
  fallback,
  className = "",
}: {
  address: string | undefined;
  fallback: ReactNode;
  className?: string;
}): JSX.Element {
  // The picture that has just failed: setting it draws this again, with the fallback.
  const [, setFailed] = useState<string>();
  const shown = address !== undefined && !isUnloadablePicture(address) ? address : undefined;
  if (shown === undefined) return <>{fallback}</>;
  return (
    <img
      src={shown}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={() => {
        noteUnloadablePicture(shown);
        setFailed(shown);
      }}
      className={`size-full rounded-full bg-surface object-cover ring-1 ring-line ${className}`}
    />
  );
}
