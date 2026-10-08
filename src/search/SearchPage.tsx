import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { osmNoteUrl } from "../place/osmLinks.ts";
import { formatRadius } from "../places/distance.ts";
import { familyLabel } from "../places/kinds.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { Attribution } from "../ui/Attribution.tsx";
import { ChainCard } from "../ui/ChainCard.tsx";
import { BackIcon, FilterIcon } from "../ui/icons.tsx";
import { PlaceRow } from "../ui/PlaceRow.tsx";
import { type ShownPage, shownMemory, shownPageOf, useShownCount } from "../ui/shown.ts";
import { type Filters, filterCount, filtersFromParams, sortInUse, WIDEST_KM, withFilters } from "./filters.ts";
import { QueryField } from "./QueryField.tsx";
import { type Entry, isChain, useResults } from "./useResults.ts";

/** How many rows the results show at first, and how many more each time "Show more" is pressed. */
const PAGE_SIZE = 50;

/** Where each page of the results keeps how many rows it has shown. */
const shown = shownMemory("regulars.search.shown", PAGE_SIZE);

/** Each active filter as the chip that takes it off: Open now, the distance, then each kind. */
function activeChips(filters: Filters, locale: string): { id: string; label: string; off: Filters }[] {
  const chips: { id: string; label: string; off: Filters }[] = [];
  if (filters.open) chips.push({ id: "open", label: copy.explore.chips.open, off: { ...filters, open: false } });
  if (filters.withinKm !== WIDEST_KM) {
    chips.push({
      id: "within",
      label: copy.search.within(formatRadius(filters.withinKm, locale)),
      off: { ...filters, withinKm: WIDEST_KM },
    });
  }
  for (const family of filters.families) {
    chips.push({
      id: `kind:${family}`,
      label: familyLabel(family),
      off: { ...filters, families: filters.families.filter((each) => each !== family) },
    });
  }
  return chips;
}

/** The rows, fifty at first and fifty more each time "Show more" is pressed, with the focus moved to the first new row. */
function Rows({
  page,
  entries,
  locale,
  now,
}: {
  page: ShownPage;
  entries: Entry[];
  locale: string;
  now: Date;
}): JSX.Element {
  const [count, setCount] = useShownCount(shown, page, entries.length);
  const list = useRef<HTMLUListElement>(null);
  const focusAt = useRef<number | null>(null);

  useEffect(() => {
    if (focusAt.current === null) return;
    list.current?.children[focusAt.current]?.querySelector("a")?.focus();
    focusAt.current = null;
  }, [count]);

  return (
    <>
      <ul ref={list} role="list" className="m-0 flex list-none flex-col p-0">
        {entries.slice(0, count).map((entry) =>
          isChain(entry) ? (
            <li key={`chain:${entry.chain.key}:${entry.chain.country}`}>
              <ChainCard variant="row" chain={entry.chain} nearby={entry.nearby} locale={locale} now={now} />
            </li>
          ) : (
            <li key={entry.place.address}>
              <PlaceRow place={entry.place} km={entry.km} locale={locale} now={now} />
            </li>
          ),
        )}
      </ul>
      {count < entries.length && (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            onClick={() => {
              focusAt.current = count;
              setCount(count + PAGE_SIZE);
            }}
            className="inline-flex h-11 cursor-pointer items-center rounded-button border-token border-line-strong bg-ground px-6 font-text text-body font-semibold text-ink"
          >
            {copy.search.showMore}
          </button>
        </div>
      )}
    </>
  );
}

/** What the page says in place of the rows. Nothing here went wrong, so it is a status and not an alert. */
function NoResults({
  query,
  near,
  filtersOn,
  openLeftNone,
}: {
  query: string;
  near: string;
  filtersOn: boolean;
  /** Open now is what left none: closed places match. */
  openLeftNone: boolean;
}): JSX.Element {
  let text: string;
  let hint: string | undefined;
  if (openLeftNone) {
    text = query === "" ? copy.search.noResultsFiltered(near) : copy.search.noResultsOpen(query, near);
  } else if (query !== "") {
    text = copy.search.noResults(query, near);
    hint = copy.search.noResultsHint;
  } else if (filtersOn) {
    text = copy.search.noResultsFiltered(near);
    hint = copy.search.noResultsFilteredHint;
  } else {
    text = copy.explore.noneNearby(near);
  }
  return (
    <div className="flex flex-col items-center gap-2 px-gutter-phone py-12 text-center">
      <p role="status" className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">
        {text}
      </p>
      {hint !== undefined && <p className="m-0 max-w-[36ch] text-secondary leading-[1.4] text-muted">{hint}</p>}
    </div>
  );
}

/**
 * The search results (Search.dc.html; screen 3). On a phone it has the way back, the search field,
 * the Filters chip with a chip for each filter that is on, the line of how many and in what order,
 * the rows (a chain as one), a note on the closed places Open now left out, and, at the foot, a link
 * to add a place that is missing and where the details come from. Everything the page is showing is
 * in the address (`?q=&open=&kinds=&within=&sort=`), so a link to it, and Back, show the same.
 *
 * On a desktop the top bar has the search field, so the page is the chips, the line and the rows in a column.
 */
export function SearchPage(): JSX.Element {
  useDocumentTitle(copy.titles.search);
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();
  const navigationType = useNavigationType();

  const query = (params.get("q") ?? "").trim();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const sort = sortInUse(filters);
  const { entries, hiddenClosed } = useResults(query, filters);
  const chips = activeChips(filters, locale);

  // The cursor goes to the field when the person arrives to search, or to an address typed in. Not when
  // they come Back to the results: the keyboard would cover them.
  const [focusField] = useState(() => !wide && !(navigationType === "POP" && historyKey !== "default"));

  // A filter is a step the Back button undoes; the words are not: each letter that is searched for would be one.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next));
  const setQuery = (words: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (words === "") next.delete("q");
        else next.set("q", words);
        return next;
      },
      { replace: true },
    );

  const search = params.toString();
  const list = `${query}|${search}|${here.lat}|${here.lon}`;
  const page = shownPageOf(historyKey, list);

  return (
    <div className="mx-auto flex w-full max-w-content flex-1 flex-col wide:px-gutter-desktop">
      <div className="flex flex-1 flex-col wide:max-w-measure">
        {/* 20 px at the right, 8 at the left, where the back button's own 44 px box puts its arrow in line with the gutter. */}
        <header className="flex flex-col gap-3.5 pt-3.5 pr-5 pl-2 wide:p-0 wide:pt-5">
          <h1 className="sr-only">{copy.pages.search}</h1>
          {!wide && (
            <div className="flex items-center gap-1">
              <Link
                to="/"
                aria-label={copy.search.back}
                className="flex size-11 shrink-0 items-center justify-center text-ink"
              >
                <BackIcon size={22} />
              </Link>
              <QueryField value={query} onSearch={setQuery} autoFocus={focusField} />
            </div>
          )}

          <div
            role="group"
            aria-label={copy.explore.filtersLabel}
            className="flex flex-wrap gap-2 pl-3 wide:pl-0"
          >
            <Link
              to={search === "" ? "/filters" : `/filters?${search}`}
              className="inline-flex h-11 items-center gap-1.5 rounded-chip border-token border-ink px-3.5 text-secondary font-bold text-ink no-underline"
            >
              <FilterIcon size={16} />
              {copy.search.filters(filterCount(filters))}
            </Link>
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                aria-pressed="true"
                onClick={() => setFilters(chip.off)}
                className="h-11 cursor-pointer rounded-chip border-0 bg-ink px-3.5 font-text text-secondary font-semibold text-ground"
              >
                {chip.label}
              </button>
            ))}
          </div>

          {entries.length > 0 && (
            <p role="status" className="m-0 pl-3 text-secondary leading-[1.4] text-muted wide:pl-0">
              {copy.search.summary(entries.length, here.label, copy.search.sortedBy[sort])}
            </p>
          )}
        </header>

        <div className="px-gutter-phone pt-2 wide:px-0">
          {entries.length > 0 ? (
            <Rows key={`${historyKey}|${list}`} page={page} entries={entries} locale={locale} now={now} />
          ) : (
            <NoResults
              query={query}
              near={here.label}
              filtersOn={filterCount(filters) > 0}
              openLeftNone={hiddenClosed > 0}
            />
          )}
        </div>

        {hiddenClosed > 0 && (
          <div className="px-gutter-phone pt-5 wide:px-0">
            <section className="flex flex-col gap-1.5 rounded-card bg-surface p-4">
              <div className="text-[15px] font-bold">{copy.search.hiddenClosed(hiddenClosed)}</div>
              <div className="text-secondary leading-[1.45] text-muted">{copy.search.hoursNote}</div>
              <button
                type="button"
                onClick={() => setFilters({ ...filters, open: false })}
                className="h-11 cursor-pointer self-start border-0 bg-transparent p-0 font-text text-secondary font-bold text-accent"
              >
                {copy.search.showClosed}
              </button>
            </section>
          </div>
        )}

        <footer className="mt-auto flex flex-col gap-0.5 px-gutter-phone pt-[18px] pb-[22px] wide:px-0">
          <a
            href={osmNoteUrl(here.lat, here.lon)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-touch items-center self-start text-caption font-semibold text-ink underline hover:text-accent"
          >
            {copy.search.addMissing}
          </a>
          <Attribution kind="details" />
        </footer>
      </div>
    </div>
  );
}
