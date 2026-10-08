import { type JSX, type RefObject, useEffect, useRef } from "react";

import { copy } from "../copy/en.ts";
import { type Entry, entryAddress } from "../map/pins.ts";
import { ChainCard } from "../ui/ChainCard.tsx";
import { PlaceCard } from "../ui/PlaceCard.tsx";
import { type ShownPage, shownMemory, useShownCount } from "../ui/shown.ts";

/** How many cards the list shows at first, and how many more each time it reaches its end. */
export const PAGE_SIZE = 30;

/** The end of the list is looked for this far below what is in view, so the next cards are there before they are scrolled to. */
const LOOK_AHEAD = "0px 0px 600px 0px";

/** Where each page of the list keeps how many cards it has shown. */
const shown = shownMemory("regulars.explore.shown", PAGE_SIZE);

/**
 * Explore's cards (Main.dc.html, DeskExplore.dc.html), thirty at first and thirty more each time
 * the end comes into view. Where the browser cannot watch for that, or the person would rather not
 * scroll, the button after the last card does it. When it is pressed the focus moves to the first
 * new card, so a keyboard goes on from where the list left off. `page` is this page of the history
 * and its list: Back to it shows as many cards as it had, so the scroll position is still on the page.
 *
 * Beside a map (the desktop), `selected` is the address of the chosen pin, whose card gets the dark
 * edge and is brought into view, however far down it is; a new `focusRequest` also moves the focus
 * to it (a pin chosen from the keyboard). `onHighlight` hears which card is pointed at or focused, to
 * pick out its pin. `listId` is the list's id, which the pins name as what they open. `scrollRoot`
 * is the element the list scrolls in, when it is not the page.
 */
export function Entries({
  page,
  entries,
  locale,
  now,
  selected,
  focusRequest,
  onHighlight,
  listId,
  scrollRoot,
}: {
  page: ShownPage;
  entries: Entry[];
  locale: string;
  now: Date;
  selected?: string;
  focusRequest?: number;
  onHighlight?(address: string | undefined): void;
  listId?: string;
  scrollRoot?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [count, setCount] = useShownCount(shown, page, entries.length);
  const more = count < entries.length;
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const focusAt = useRef<number | null>(null);

  // Watch the button, which sits at the end of the list. A new observer reports where the button
  // is as soon as it starts, so a list still short of the screen's end goes on loading.
  useEffect(() => {
    const target = button.current;
    if (!more || target === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((entry) => entry.isIntersecting)) setCount((n) => n + PAGE_SIZE);
      },
      { root: scrollRoot?.current ?? null, rootMargin: LOOK_AHEAD },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, count, scrollRoot]);

  useEffect(() => {
    if (focusAt.current === null) return;
    list.current?.children[focusAt.current]?.querySelector("a")?.focus();
    focusAt.current = null;
  }, [count]);

  // The chosen pin's card: shown, with the cards before it, then brought into view, once for each choice.
  const selectedAt = selected === undefined ? -1 : entries.findIndex((entry) => entryAddress(entry) === selected);
  const broughtIntoView = useRef<string | undefined>(undefined);
  const focused = useRef(focusRequest);
  useEffect(() => {
    if (selected === undefined || selectedAt < 0) {
      broughtIntoView.current = undefined;
      return;
    }
    const focus = focusRequest !== focused.current;
    if (broughtIntoView.current === selected && !focus) return;
    if (selectedAt >= count) {
      setCount(Math.ceil((selectedAt + 1) / PAGE_SIZE) * PAGE_SIZE);
      return;
    }
    broughtIntoView.current = selected;
    focused.current = focusRequest;
    const item = list.current?.children[selectedAt] as HTMLElement | undefined;
    // jsdom has no scrolling, and nor may an old browser.
    item?.scrollIntoView?.({ block: "nearest" });
    if (focus) item?.querySelector("a")?.focus({ preventScroll: true });
  }, [selected, selectedAt, count, setCount, focusRequest]);

  return (
    <>
      <ul ref={list} id={listId} role="list" className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.slice(0, count).map((entry) => {
          const address = entryAddress(entry);
          const chosen = address === selected;
          const point =
            onHighlight === undefined
              ? {}
              : {
                  onMouseEnter: () => onHighlight(address),
                  onMouseLeave: () => onHighlight(undefined),
                  onFocus: () => onHighlight(address),
                  onBlur: () => onHighlight(undefined),
                };
          return "chain" in entry ? (
            <li key={`chain:${entry.chain.key}:${entry.chain.country}`} {...point}>
              <ChainCard chain={entry.chain} nearby={entry.nearby} locale={locale} selected={chosen} />
            </li>
          ) : (
            <li key={address} {...point}>
              <PlaceCard place={entry.place} km={entry.km} variant="normal" locale={locale} now={now} selected={chosen} />
            </li>
          );
        })}
      </ul>
      {more && (
        <div className="flex justify-center pt-3">
          <button
            ref={button}
            type="button"
            onClick={() => {
              focusAt.current = count;
              setCount(count + PAGE_SIZE);
            }}
            className="inline-flex h-11 cursor-pointer items-center rounded-button border-token border-line-strong bg-ground px-6 font-text text-body font-semibold text-ink"
          >
            {copy.explore.showMore}
          </button>
        </div>
      )}
    </>
  );
}
