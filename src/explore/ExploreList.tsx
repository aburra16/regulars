import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { HereCityPicker } from "../location/CityPicker.tsx";
import { useHere } from "../location/useLocation.ts";
import { type ChainGroup, groupForList, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { PageMessage, primaryButton } from "../ui/Banner.tsx";
import { ChainCard } from "../ui/ChainCard.tsx";
import { ChipLink, Chips } from "../ui/Chips.tsx";
import { SearchIcon } from "../ui/icons.tsx";
import { PlaceCard } from "../ui/PlaceCard.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { CHIP_LABELS, CHIP_PARAM, chipFromParam, chipKeeps, EXPLORE_CHIPS, type ExploreChip } from "./chips.ts";

/** How many cards the list shows at first, and how many more each time it reaches its end. */
const PAGE_SIZE = 30;

/** The end of the list is looked for this far below the screen, so the next cards are there before they are scrolled to. */
const LOOK_AHEAD = "0px 0px 600px 0px";

/** Where each page of the list keeps how many cards it has shown, in `sessionStorage`. */
const SHOWN_KEY = "regulars.explore.shown";

type Entry = PlaceDistance | ChainGroup<PlaceDistance>;

const isChain = (entry: Entry): entry is ChainGroup<PlaceDistance> => "chain" in entry;

const CHIP_OPTIONS = EXPLORE_CHIPS.map((id) => ({ id, label: CHIP_LABELS[id] }));

/** The search field of the phone's Explore: it looks like a field and opens the search page (Main.dc.html). */
function SearchLink(): JSX.Element {
  return (
    <Link
      to="/search"
      className="flex h-13 items-center gap-2.5 rounded-button bg-surface px-4 text-body text-muted no-underline"
    >
      <SearchIcon size={20} className="shrink-0" />
      <span>
        <span className="sr-only">{copy.search.label}:</span> {copy.search.placeholder}
      </span>
    </Link>
  );
}

/**
 * How many cards this page of the list showed last time, never more than it has, and at least
 * the first thirty.
 */
function readShown(page: string, length: number): number {
  try {
    const count = Number(window.sessionStorage.getItem(`${SHOWN_KEY}:${page}`));
    return Number.isInteger(count) ? Math.max(PAGE_SIZE, Math.min(count, length)) : PAGE_SIZE;
  } catch {
    // Storage that is blocked: the list starts from thirty.
    return PAGE_SIZE;
  }
}

function writeShown(page: string, count: number): void {
  try {
    window.sessionStorage.setItem(`${SHOWN_KEY}:${page}`, String(count));
  } catch {
    // Blocked or full. Back to this page starts from thirty.
  }
}

/**
 * The cards, thirty at first and thirty more each time the end comes into view. Where the browser
 * cannot watch for that, or the person would rather not scroll, the button after the last card
 * does it. When it is pressed the focus moves to the first new card, so a keyboard goes on from
 * where the list left off. `page` is this page of the history and its list: Back to it shows as
 * many cards as it had, so the scroll position the router restores is still on the page. A page
 * with none keeps nothing.
 */
function Entries({
  page,
  entries,
  locale,
  now,
}: {
  page: string | undefined;
  entries: Entry[];
  locale: string;
  now: Date;
}): JSX.Element {
  const [count, setCount] = useState(() => (page === undefined ? PAGE_SIZE : readShown(page, entries.length)));
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
      { rootMargin: LOOK_AHEAD },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, count]);

  const length = entries.length;
  useEffect(() => {
    if (page !== undefined) writeShown(page, Math.min(count, length));
  }, [page, count, length]);

  useEffect(() => {
    if (focusAt.current === null) return;
    list.current?.children[focusAt.current]?.querySelector("a")?.focus();
    focusAt.current = null;
  }, [count]);

  return (
    <>
      <ul ref={list} role="list" className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.slice(0, count).map((entry) =>
          isChain(entry) ? (
            <li key={`chain:${entry.chain.key}:${entry.chain.country}`}>
              <ChainCard chain={entry.chain} nearby={entry.nearby} locale={locale} />
            </li>
          ) : (
            <li key={entry.place.address}>
              <PlaceCard place={entry.place} km={entry.km} variant="normal" locale={locale} now={now} />
            </li>
          ),
        )}
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

/** No place is listed around the point: say so, and offer another town. */
function NoneNearby(): JSX.Element {
  const here = useHere();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <PageMessage
        action={
          <button type="button" aria-haspopup="dialog" onClick={() => setPicking(true)} className={primaryButton}>
            {copy.explore.chooseTown}
          </button>
        }
      >
        {copy.explore.noneNearby(here.label)}
      </PageMessage>
      {picking && <HereCityPicker onClose={() => setPicking(false)} />}
    </>
  );
}

/**
 * Explore, as a list (Main.dc.html; the phone's first screen). Below the top of the page, which the
 * shell draws, it has the search field, the toggle, the filter chips and the places near the
 * person, nearest first, chains as one card. A chip is kept in the address, so Back undoes it.
 *
 * On a desktop the top bar has the search and the toggle already, so only the line, the chips
 * and the list are here, in a column. The desktop's own Explore, with the map, replaces this.
 */
export function ExploreList(): JSX.Element {
  useDocumentTitle(copy.titles.explore);
  const wide = useWide();
  const here = useHere();
  const indexes = useIndexes();
  const now = useNow();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();
  const chip = chipFromParam(params.get(CHIP_PARAM));

  const nearby = useMemo(
    () => indexes?.near(here.lat, here.lon, config.defaultCity.radiusKm) ?? [],
    [indexes, here.lat, here.lon],
  );
  // The minute matters to the list only when it is asked which places are open.
  const openAt = chip === "open" ? now : null;
  const entries = useMemo(() => {
    if (indexes === undefined) return [];
    // Filter first, then group: a chain counts only the locations that stay.
    const kept = nearby.filter((row) => chipKeeps(chip, row.place, now));
    return groupForList(kept, indexes);
    // `now` is a dependency through `openAt`: it changes this list only while the chip asks about it.
  }, [indexes, nearby, chip, openAt]);

  const choose = (next: ExploreChip) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === "all") updated.delete(CHIP_PARAM);
      else updated.set(CHIP_PARAM, next);
      return updated;
    });

  let body: JSX.Element;
  if (nearby.length === 0) {
    body = <NoneNearby />;
  } else if (entries.length === 0) {
    body = (
      <PageMessage
        action={
          <button type="button" onClick={() => choose("all")} className={primaryButton}>
            {copy.explore.showAll}
          </button>
        }
      >
        {copy.explore.noneMatching}
      </PageMessage>
    );
  } else {
    // A new chip is a new page of the history, and a new town is a new list: each starts from its first thirty.
    // The first page of a tab, and any address typed in or followed from elsewhere, have the key "default"
    // between them, so a depth kept under it would belong to whichever of them was there last: none is kept.
    const list = `${chip}|${here.lat}|${here.lon}`;
    const page = historyKey === "default" ? undefined : `${historyKey}|${list}`;
    body = (
      <div className="px-gutter-phone pt-[18px]">
        <Entries key={`${historyKey}|${list}`} page={page} entries={entries} locale={locale} now={now} />
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-5 wide:mx-auto wide:w-list">
      <div className="flex flex-col gap-4 px-gutter-phone pt-4">
        <h1 className="sr-only">{copy.pages.explore}</h1>
        {!wide && <SearchLink />}
        <div className="flex flex-col gap-2">
          {!wide && <ViewSwitch variant="bar" />}
          <p className="m-0 text-secondary leading-[1.4] text-muted">
            {copy.explore.houseLine}{" "}
            <Link to="/about#how-scores-work" className="font-semibold text-ink underline hover:text-accent">
              {copy.explore.howThisWorks}
            </Link>
          </p>
        </div>
        <Chips
          label={copy.explore.filtersLabel}
          options={CHIP_OPTIONS}
          value={chip}
          resting="all"
          onChange={choose}
        >
          <ChipLink to="/filters">{copy.explore.chips.more}</ChipLink>
        </Chips>
      </div>
      {body}
    </div>
  );
}
