import { type JSX, type RefObject, useEffect, useRef } from "react";

import { copy } from "../copy/en.ts";
import { type Entry, entryAddress } from "../map/pins.ts";
import type { ListScores } from "../score/useListScores.ts";
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
 * to it (a pin chosen from the keyboard). `first` is a card before the list's own, and not one of
 * them: the place of a pin chosen on a map of every place that the list does not hold. `onHighlight`
 * hears which card is pointed at or focused, to pick out its pin. `listId` is the list's id, which
 * the pins name as what they open. `scrollRoot` is the element the list scrolls in, when it is not
 * the page.
 *
 * `scores` are the list's places' scores, asked for by the page for the whole list at once. A place
 * only others have rated is a dashed card in a list where some place has a score (Main.dc.html).
 */
export function Entries({
  page,
  entries,
  first,
  locale,
  now,
  selected,
  focusRequest,
  onHighlight,
  listId,
  scrollRoot,
  scores,
}: {
  page: ShownPage;
  entries: Entry[];
  first?: Entry;
  locale: string;
  now: Date;
  selected?: string;
  focusRequest?: number;
  onHighlight?(address: string | undefined): void;
  listId?: string;
  scrollRoot?: RefObject<HTMLElement | null>;
  scores?: ListScores;
}): JSX.Element {
  const [count, setCount] = useShownCount(shown, page, entries.length);
  const more = count < entries.length;
  // The cards on the page: `first`, if there is one, then as many of the list's as are shown.
  const before = first === undefined ? 0 : 1;
  const cards = first === undefined ? entries.slice(0, count) : [first, ...entries.slice(0, count)];
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
  // Its place in `first` and the list together, which is its place among the list's items.
  const all = first === undefined ? entries : [first, ...entries];
  const selectedAt = selected === undefined ? -1 : all.findIndex((entry) => entryAddress(entry) === selected);
  const broughtIntoView = useRef<string | undefined>(undefined);
  const focused = useRef(focusRequest);
  useEffect(() => {
    if (selected === undefined || selectedAt < 0) {
      broughtIntoView.current = undefined;
      return;
    }
    const focus = focusRequest !== focused.current;
    if (broughtIntoView.current === selected && !focus) return;
    if (selectedAt >= before + count) {
      setCount(Math.ceil((selectedAt - before + 1) / PAGE_SIZE) * PAGE_SIZE);
      return;
    }
    broughtIntoView.current = selected;
    focused.current = focusRequest;
    const item = list.current?.children[selectedAt] as HTMLElement | undefined;
    // jsdom has no scrolling, and nor may an old browser.
    item?.scrollIntoView?.({ block: "nearest" });
    if (focus) item?.querySelector("a")?.focus({ preventScroll: true });
  }, [selected, selectedAt, before, count, setCount, focusRequest]);

  return (
    <>
      <ul ref={list} id={listId} role="list" className="m-0 flex list-none flex-col gap-3 p-0">
        {cards.map((entry, i) => {
          const address = entryAddress(entry);
          // One card is the chosen one, even when a chain's nearest place is chosen and is the first card too.
          const chosen = i === selectedAt;
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
              <PlaceCard
                place={entry.place}
                km={entry.km}
                variant={scores?.anyScored === true && scores.of(address).kind === "unscored" ? "unrated-dashed" : "normal"}
                score={scores?.of(address)}
                locale={locale}
                now={now}
                selected={chosen}
              />
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
              focusAt.current = before + count;
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
