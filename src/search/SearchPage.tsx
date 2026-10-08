import { type JSX, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { stepsBackToExplore } from "../explore/returnPoint.ts";
import { useHere } from "../location/useLocation.ts";
import { osmNoteUrl } from "../place/osmLinks.ts";
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
import {
  cameFromFilters,
  type Filters,
  filterCount,
  filtersFromParams,
  widestKm,
  withFilters,
  withinLabel,
} from "./filters.ts";
import { QueryField, type QueryFieldHandle } from "./QueryField.tsx";
import { type Entry, isChain, useResults } from "./useResults.ts";

/** How many rows the results show at first, and how many more each time "Show more" is pressed. */
const PAGE_SIZE = 50;

/** Where each page of the results keeps how many rows it has shown. */
const shown = shownMemory("regulars.search.shown", PAGE_SIZE);

/** How much of a search a sentence says back: a search that is a paragraph, or one long word, would fill the page. */
const ECHO_MAX = 80;

/** The words searched for as a sentence says them: the first eighty characters, then an ellipsis. Cut between characters, not through one. */
function echo(query: string): string {
  const characters = [...query];
  return characters.length > ECHO_MAX ? `${characters.slice(0, ECHO_MAX).join("")}…` : query;
}

/** An address with the words searched for set, or taken out when there are none; the rest of it is as it was. */
function withQuery(params: URLSearchParams, words: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (words === "") next.delete("q");
  else next.set("q", words);
  return next;
}

const filtersPath = (params: URLSearchParams) => (params.toString() === "" ? "/filters" : `/filters?${params}`);

/** A click that is the link's own to handle: a new tab or window is the browser's, with the link's address as it is. */
const isPlainClick = (event: MouseEvent<HTMLElement>) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Each active filter as the chip that takes it off: Open now, the distance, then each kind. */
function activeChips(filters: Filters, locale: string): { id: string; label: string; off: Filters }[] {
  const chips: { id: string; label: string; off: Filters }[] = [];
  if (filters.open) chips.push({ id: "open", label: copy.explore.chips.open, off: { ...filters, open: false } });
  if (filters.withinKm !== widestKm(locale)) {
    chips.push({
      id: "within",
      label: copy.search.within(withinLabel(filters.withinKm, locale)),
      off: { ...filters, withinKm: widestKm(locale) },
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

/**
 * What the page says in place of the rows, and a hint under it. Nothing here went wrong, so none
 * of it is an alert. `openLeftNone`: Open now is what left none, closed places match.
 */
function emptyMessage({
  query,
  near,
  filtersOn,
  openLeftNone,
}: {
  query: string;
  near: string;
  filtersOn: boolean;
  openLeftNone: boolean;
}): { sentence: string; hint?: string } {
  if (openLeftNone) {
    return { sentence: query === "" ? copy.search.noResultsFiltered(near) : copy.search.noResultsOpen(echo(query), near) };
  }
  if (query !== "") return { sentence: copy.search.noResults(echo(query), near), hint: copy.search.noResultsHint };
  if (filtersOn) return { sentence: copy.search.noResultsFiltered(near), hint: copy.search.noResultsFilteredHint };
  return { sentence: copy.explore.noneNearby(near) };
}

/** A place rounded to four decimals, about eleven metres: as exact as a note about a missing place needs, and no more of where a person is. */
const round4 = (degrees: number) => Math.round(degrees * 1e4) / 1e4;

/**
 * The search results (Search.dc.html; screen 3). On a phone it has the way back, the search field,
 * the Filters chip with a chip for each filter that is on, the line of how many and in what order,
 * the rows (a chain as one), a note on the closed places Open now left out, and, at the foot, a link
 * to add a place that is missing and where the details come from. Everything the page is showing is
 * in the address (`?q=&open=&kinds=&within=&sort=`), so a link to it, and Back, show the same.
 *
 * The line, or the sentence that says there is nothing, is in one live region that is always on the
 * page, so a screen reader announces each change to it.
 *
 * On a desktop the top bar has the search field, so the page is the chips, the line and the rows in a column.
 */
export function SearchPage(): JSX.Element {
  useDocumentTitle(copy.titles.search);
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { key: historyKey, state } = useLocation();
  const navigationType = useNavigationType();

  const query = (params.get("q") ?? "").trim();
  const filters = useMemo(() => filtersFromParams(params, locale), [params, locale]);
  const { entries, hiddenClosed, order } = useResults(query, filters);
  const chips = activeChips(filters, locale);

  // The cursor goes to the field when the person arrives to search, or to an address typed in. Not when
  // they come Back to the results, or from the filters page: the keyboard would cover the results.
  const [focusField] = useState(
    () => !wide && !cameFromFilters(state) && !(navigationType === "POP" && historyKey !== "default"),
  );

  const field = useRef<QueryFieldHandle>(null);
  const chipGroup = useRef<HTMLDivElement>(null);
  // The chip that took its filter off, as its place among the chips: the one that is there now is the next.
  const focusChipAt = useRef<number | null>(null);

  // A filter is a step the Back button undoes; the words are not: each letter that is searched for would be one.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next, locale));
  const takeOff = (index: number, next: Filters) => {
    focusChipAt.current = index;
    setFilters(next);
  };
  const setQuery = (words: string) => navigate({ search: withQuery(params, words).toString() }, { replace: true });

  // A chip that took its filter off is not there to hold the focus. Give it to the chip in its place, or to the Filters chip.
  useEffect(() => {
    const index = focusChipAt.current;
    if (index === null) return;
    focusChipAt.current = null;
    const group = chipGroup.current;
    const toggles = group?.querySelectorAll<HTMLElement>("button[aria-pressed]");
    (toggles?.[index] ?? group?.querySelector<HTMLElement>("a"))?.focus();
  }, [filters]);

  const search = params.toString();
  const list = `${query}|${search}|${here.lat}|${here.lon}`;
  const page = shownPageOf(historyKey, list);
  const empty =
    entries.length === 0
      ? emptyMessage({ query, near: here.label, filtersOn: filterCount(filters, locale) > 0, openLeftNone: hiddenClosed > 0 })
      : undefined;
  const noteUrl =
    here.source === "device" ? osmNoteUrl(round4(here.lat), round4(here.lon)) : osmNoteUrl(here.lat, here.lon);

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
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  // Words that were typed a moment ago are kept in the page this one leaves. Then back to the
                  // Explore the search was opened from, in one step whatever the search has done since (its
                  // filters, a chip, a new search), or, where there is none behind this page, to Explore as a new step.
                  const go = () => {
                    const steps = stepsBackToExplore();
                    void (steps === undefined ? navigate("/") : navigate(steps));
                  };
                  const typed = field.current?.flush();
                  if (typed === undefined) go();
                  else void typed.then(go);
                }}
                className="flex size-11 shrink-0 items-center justify-center text-ink"
              >
                <BackIcon size={22} />
              </Link>
              <QueryField ref={field} value={query} onSearch={setQuery} autoFocus={focusField} />
            </div>
          )}

          <div
            ref={chipGroup}
            role="group"
            aria-label={copy.explore.filtersLabel}
            className="flex flex-wrap gap-2 pl-3 wide:pl-0"
          >
            <Link
              to={filtersPath(params)}
              onClick={(event) => {
                // With nothing typed and waiting, the link goes by itself.
                if (!isPlainClick(event) || field.current?.pending() !== true) return;
                event.preventDefault();
                void field.current.flush().then((words) => navigate(filtersPath(withQuery(params, words))));
              }}
              className="inline-flex h-11 items-center gap-1.5 rounded-chip border-token border-ink px-3.5 text-secondary font-bold text-ink no-underline"
            >
              <FilterIcon size={16} />
              {copy.search.filters(filterCount(filters, locale))}
            </Link>
            {chips.map((chip, index) => (
              <button
                key={chip.id}
                type="button"
                aria-pressed="true"
                onClick={() => takeOff(index, chip.off)}
                className="h-11 cursor-pointer rounded-chip border-0 bg-ink px-3.5 font-text text-secondary font-semibold text-ground"
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div role="status" className="pl-3 wide:pl-0">
            {empty === undefined ? (
              <p className="m-0 text-secondary leading-[1.4] text-muted">
                {copy.search.summary(entries.length, here.label, copy.search.sortedBy[order])}
              </p>
            ) : (
              <p className="m-0 min-w-0 text-body leading-[1.5] wrap-break-word text-ink-soft">{empty.sentence}</p>
            )}
          </div>
        </header>

        <div className="px-gutter-phone pt-2 wide:px-0">
          {empty === undefined ? (
            <Rows key={`${historyKey}|${list}`} page={page} entries={entries} locale={locale} now={now} />
          ) : (
            empty.hint !== undefined && <p className="m-0 text-secondary leading-[1.4] text-muted">{empty.hint}</p>
          )}
        </div>

        {hiddenClosed > 0 && (
          <div className="px-gutter-phone pt-5 wide:px-0">
            <section className="flex flex-col gap-1.5 rounded-card bg-surface p-4">
              <div className="text-[15px] font-bold">{copy.search.hiddenClosed(hiddenClosed)}</div>
              <div className="text-secondary leading-[1.45] text-muted">{copy.search.hoursNote}</div>
              <button
                type="button"
                onClick={() => takeOff(0, { ...filters, open: false })}
                className="h-11 cursor-pointer self-start border-0 bg-transparent p-0 font-text text-secondary font-bold text-accent"
              >
                {copy.search.showClosed}
              </button>
            </section>
          </div>
        )}

        <footer className="mt-auto flex flex-col gap-0.5 px-gutter-phone pt-[18px] pb-[22px] wide:px-0">
          {noteUrl !== "" && (
            <a
              href={noteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-touch items-center self-start text-caption font-semibold text-ink underline hover:text-accent"
            >
              {copy.search.addMissing}{" "}
              <span className="sr-only">{copy.common.newTab}</span>
            </a>
          )}
          <Attribution kind="details" />
        </footer>
      </div>
    </div>
  );
}
