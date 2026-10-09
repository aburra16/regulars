import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { stepsBackToExplore } from "../explore/returnPoint.ts";
import { useHere } from "../location/useLocation.ts";
import { familyLabel } from "../places/kinds.ts";
import { type ListScores, useListScores } from "../score/useListScores.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { Attribution } from "../ui/Attribution.tsx";
import { ChainCard } from "../ui/ChainCard.tsx";
import { BackIcon, FilterIcon } from "../ui/icons.tsx";
import { PlaceRow } from "../ui/PlaceRow.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { type ShownPage, shownMemory, shownPageOf, useShownCount } from "../ui/shown.ts";
import { Elsewhere, TownsFound } from "./Beyond.tsx";
import { DeskSearch } from "./DeskSearch.tsx";
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
import { AddMissingLink, EmptyHint, emptyMessage, HiddenClosedNote, ResultsLine } from "./ResultsParts.tsx";
import { useBeyond } from "./useBeyond.ts";
import { type Entry, isChain, useResults } from "./useResults.ts";

/** How many rows the results show at first, and how many more each time "Show more" is pressed. */
const PAGE_SIZE = 50;

/** Where each page of the results keeps how many rows it has shown. */
const shown = shownMemory("regulars.search.shown", PAGE_SIZE);

/** An address with the words searched for set, or taken out when there are none; the rest of it is as it was. */
function withQuery(params: URLSearchParams, words: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (words === "") next.delete("q");
  else next.set("q", words);
  return next;
}

const filtersPath = (params: URLSearchParams) => (params.toString() === "" ? "/filters" : `/filters?${params}`);


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

/**
 * The rows, fifty at first and fifty more each time "Show more" is pressed, with the focus moved to
 * the first new row. Each place has its score, from `scores`, which the page asked for in one go.
 */
function Rows({
  page,
  entries,
  scores,
  locale,
  now,
}: {
  page: ShownPage;
  entries: Entry[];
  scores: ListScores;
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
              <PlaceRow place={entry.place} km={entry.km} score={scores.of(entry.place.address)} locale={locale} now={now} />
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
 * The search results on a phone (Search.dc.html; screen 3): the way back, the search field, the towns
 * the words name (`TownsFound`), the Filters chip with a chip for each filter that is on, the line of
 * how many and in what order, the rows (a chain as one), a note on the closed places Open now left
 * out, the places elsewhere whose names have the words (`Elsewhere`), and, at the foot, a link to add a
 * place that is missing and where the details come from. Everything the page is showing is in the
 * address (`?q=&open=&kinds=&within=&sort=`), so a link to it, and Back, show the same.
 *
 * The line, or the sentence that says there is nothing, is in one live region that is always on the
 * page, so a screen reader announces each change to it.
 */
function PhoneSearch(): JSX.Element {
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { key: historyKey, state } = useLocation();
  const navigationType = useNavigationType();

  const query = (params.get("q") ?? "").trim();
  const filters = useMemo(() => filtersFromParams(params, locale), [params, locale]);
  const results = useResults(query, filters);
  const { count, hiddenClosed, order } = results;
  // The scores of every result, asked for in one go; best first when the person asked for that.
  const { entries, scores } = useListScores(results.entries, order === "score");
  const beyond = useBeyond(query);
  const chips = activeChips(filters, locale);

  // The cursor goes to the field when the person arrives to search, or to an address typed in. Not when
  // they come Back to the results, or from the filters page: the keyboard would cover the results.
  const [focusField] = useState(() => !cameFromFilters(state) && !(navigationType === "POP" && historyKey !== "default"));

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

  return (
    <div className="flex w-full flex-1 flex-col">
      {/* 20 px at the right, 8 at the left, where the back button's own 44 px box puts its arrow in line with the gutter. */}
      <header className="flex flex-col gap-3.5 pt-3.5 pr-5 pl-2">
        <h1 className="sr-only">{copy.pages.search}</h1>
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

        <TownsFound towns={beyond.towns} className="pl-3" />

        <div ref={chipGroup} role="group" aria-label={copy.explore.filtersLabel} className="flex flex-wrap gap-2 pl-3">
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
              className="h-11 cursor-pointer rounded-chip border-0 bg-emphasis px-3.5 font-text text-secondary font-semibold text-on-emphasis"
            >
              {chip.label}
            </button>
          ))}
        </div>

        <ResultsLine empty={empty} count={count} near={here.label} order={order} className="pl-3" />
      </header>

      <div className="px-gutter-phone pt-2">
        {empty === undefined ? (
          <Rows key={`${historyKey}|${list}`} page={page} entries={entries} scores={scores} locale={locale} now={now} />
        ) : (
          empty.hint !== undefined && <EmptyHint hint={empty.hint} />
        )}
      </div>

      {hiddenClosed > 0 && (
        <div className="px-gutter-phone pt-5">
          <HiddenClosedNote count={hiddenClosed} onShowClosed={() => takeOff(0, { ...filters, open: false })} />
        </div>
      )}

      <Elsewhere
        rows={beyond.elsewhere}
        near={here.label}
        unfiltered={filterCount(filters, locale) > 0 || filters.sort !== undefined}
        locale={locale}
        now={now}
        className="px-gutter-phone pt-5"
      />

      <footer className="mt-auto flex flex-col gap-0.5 px-gutter-phone pt-[18px] pb-[22px]">
        <AddMissingLink />
        <Attribution kind="details" />
      </footer>
    </div>
  );
}

/**
 * The search results (screen 3), at `/search`. A phone has its own page; a desktop shows the results
 * in Explore's layout, the list beside the map, with the filters as menus (the brief's D1).
 */
export function SearchPage(): JSX.Element {
  useDocumentTitle(copy.titles.search);
  return useWide() ? <DeskSearch /> : <PhoneSearch />;
}
