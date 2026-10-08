import type { JSX } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { BackIcon } from "./icons.tsx";
import { isPlainClick } from "./plainClick.ts";

/**
 * The way back from a page that opens from a list (a place, a chain): the page the person came from,
 * when they came from one in the app; Explore when this was the first page opened (a shared link).
 * On a phone it is the arrow alone (PlaceNew.dc.html, Chain.dc.html); on a desktop the arrow and its
 * words (DeskPlace.dc.html).
 */
export function BackLink({ wide }: { wide: boolean }): JSX.Element {
  const navigate = useNavigate();
  const { key } = useLocation();
  const inApp = key !== "default";
  const words = inApp ? copy.place.back : copy.place.backHome;
  return (
    <Link
      to="/"
      aria-label={wide ? undefined : words}
      onClick={(event) => {
        if (!inApp || !isPlainClick(event)) return;
        event.preventDefault();
        void navigate(-1);
      }}
      className={
        wide
          ? "inline-flex min-h-touch items-center gap-1.5 self-start text-[15px] font-semibold text-ink no-underline hover:text-accent"
          : "flex size-11 items-center justify-center rounded-full text-ink"
      }
    >
      <BackIcon size={wide ? 18 : 22} />
      {wide && words}
    </Link>
  );
}
