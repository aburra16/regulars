import { type JSX, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { lockPage } from "../ui/lockPage.ts";
import { ReviewForm, ReviewingAs, ReviewTitle } from "./ReviewForm.tsx";
import type { Posting } from "./usePost.ts";

/** What the Tab key can reach inside the dialog: not the stars that are not the radio group's stop. */
const FOCUSABLE = 'a[href], button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled])';

/**
 * The review form on a desktop (D3, DeskReview.dc.html): a dialog over the place's page, which is
 * dimmed in the shade behind it, and out of reach while it is open. The focus starts at the stars,
 * the Tab key stays inside, and closing it (the cross or Escape: `close`; or posting, `posting`'s) goes
 * back to the place's page and gives the focus back to what opened it: "Rate this place".
 */
export function ReviewDialog({ place, close, posting }: { place: Place; close(): void; posting: Posting }): JSX.Element {
  useDocumentTitle(copy.titles.review(place.name));
  const dialogRef = useRef<HTMLDivElement>(null);

  // The page behind can be neither scrolled nor reached while this is open. This effect comes before
  // the focus one: a closing dialog runs its cleanups in this order, so the page is reachable again by
  // the time the focus goes back to it.
  useEffect(() => lockPage(), []);

  // The focus goes to the star chosen, or the first, when it opens, and back to what had it when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    const start =
      dialog?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? dialog?.querySelector<HTMLElement>('[role="radio"]');
    start?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Escape closes. The Tab key stays inside, because the page behind is out of reach.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || dialog === null) return;
      const reachable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = reachable[0];
      const last = reachable.at(-1);
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // No closing on a click beside it: that would lose what the person typed.
  return createPortal(
    <div className="fixed inset-0 z-50 flex overflow-y-auto overscroll-contain bg-shade/60 px-4 py-10">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.review.dialogLabel}
        className="m-auto flex w-full max-w-[580px] min-w-0 flex-col gap-[22px] rounded-dialog bg-ground px-7 pt-2.5 pb-7 font-text text-ink shadow-dialog"
      >
        {/* Who is reviewing, and the cross, whose 44 px target reaches into the dialog's edge. */}
        <div className="-mr-3.5 flex min-w-0 items-center justify-between gap-3">
          <ReviewingAs className="text-secondary text-muted" />
          <button
            type="button"
            aria-label={copy.review.close}
            onClick={close}
            className="flex min-h-touch min-w-touch shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-ink"
          >
            <CloseIcon size={22} />
          </button>
        </div>
        <ReviewTitle place={place} wide className="-mt-3.5" />
        <ReviewForm place={place} wide posting={posting} />
      </div>
    </div>,
    document.body,
  );
}
