import type { JSX } from "react";
import { Link, useOutletContext } from "react-router-dom";

import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useWide } from "../shell/useWide.ts";
import { BackIcon } from "../ui/icons.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { useBackToPlace } from "./backToPlace.ts";
import { ReviewDialog } from "./ReviewDialog.tsx";
import { ReviewForm, ReviewingAs, ReviewTitle } from "./ReviewForm.tsx";

/**
 * The review form on a phone (screen 8, Review.dc.html): a page of its own at `/place/:d/review`, with
 * the arrow back to the place at the top left, and who is reviewing at the right; the place's name;
 * then the form, Post at the foot.
 */
function ReviewPage({ place }: { place: Place }): JSX.Element {
  useDocumentTitle(copy.titles.review(place.name));
  const { to, back } = useBackToPlace(place);
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-3 px-3 pt-3.5">
        <Link
          to={to}
          aria-label={copy.review.back}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            back();
          }}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink"
        >
          <BackIcon size={22} />
        </Link>
        <ReviewingAs className="pr-3 text-secondary text-muted" />
      </div>
      <ReviewTitle place={place} wide={false} className="px-gutter-phone pt-2.5" />
      <ReviewForm place={place} wide={false} onPosted={back} />
    </div>
  );
}

/**
 * The review form, at `/place/:d/review`, for the place the place's page gives it: a page of its own
 * on a phone (screen 8), a dialog over the place's page on a desktop (D3).
 */
export function ReviewRoute(): JSX.Element {
  const place = useOutletContext<Place>();
  return useWide() ? <ReviewDialog place={place} /> : <ReviewPage place={place} />;
}
