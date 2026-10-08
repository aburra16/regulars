import { type JSX, useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { DeskLayout } from "../explore/DeskLayout.tsx";
import { FilterMenus } from "../explore/FilterMenus.tsx";
import { useHere } from "../location/useLocation.ts";
import { boundsOf } from "../map/area.ts";
import { useLocale } from "../shell/useLocale.ts";
import { type Filters, filterCount, filtersFromParams, withFilters } from "./filters.ts";
import { AddMissingLink, EmptyHint, emptyMessage, HiddenClosedNote, ResultsLine } from "./ResultsParts.tsx";
import { isChain, useResults } from "./useResults.ts";

/**
 * The search results on a desktop (the brief's D1: the phone's Explore, map, search and filters are
 * one page there). It is Explore's layout in results mode: the filters as menus above the list, the
 * line of how many in its live region, the results as cards (a chain as one), the note on the closed
 * places Open now left out, and the map beside them with a pin for each, fitted to them. The top bar
 * has the search field. Everything is in the address, as on the phone's page.
 */
export function DeskSearch(): JSX.Element {
  const here = useHere();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();

  const query = (params.get("q") ?? "").trim();
  const filters = useMemo(() => filtersFromParams(params, locale), [params, locale]);
  const { entries, hiddenClosed, order } = useResults(query, filters);

  // A filter is a step the Back button undoes, as on Explore.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next, locale));

  // The map shows every result: a place's pin at the place, a chain's at its nearest.
  const fit = useMemo(
    () =>
      boundsOf(
        entries.map((entry) => {
          const place = isChain(entry) ? entry.nearby[0]!.place : entry.place;
          return { lat: place.lat, lon: place.lon };
        }),
      ),
    [entries],
  );

  const empty =
    entries.length === 0
      ? emptyMessage({ query, near: here.label, filtersOn: filterCount(filters, locale) > 0, openLeftNone: hiddenClosed > 0 })
      : undefined;

  return (
    <DeskLayout
      title={copy.pages.search}
      historyKey={historyKey}
      // New words, a new filter, or a new place to be near is a new list, which starts from its first cards.
      list={`search|${query}|${params.toString()}|${here.lat}|${here.lon}`}
      head={
        <>
          <FilterMenus filters={filters} order={order} onChange={setFilters} locale={locale} />
          <ResultsLine empty={empty} count={entries.length} near={here.label} order={order} />
        </>
      }
      entries={entries}
      instead={empty === undefined ? undefined : empty.hint !== undefined && <EmptyHint hint={empty.hint} />}
      after={
        hiddenClosed > 0 && <HiddenClosedNote count={hiddenClosed} onShowClosed={() => setFilters({ ...filters, open: false })} />
      }
      foot={<AddMissingLink />}
      mapKey={`search:${historyKey}`}
      fit={fit}
    />
  );
}
