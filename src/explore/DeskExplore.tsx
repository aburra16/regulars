import { type JSX, useLayoutEffect, useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { placeCount } from "../places/indexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { type Filters, filtersFromParams, sortInUse, withFilters } from "../search/filters.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { PageMessage } from "../ui/Banner.tsx";
import { DeskLayout } from "./DeskLayout.tsx";
import { HouseLine, NoneNearby } from "./ExploreList.tsx";
import { FilterMenus } from "./FilterMenus.tsx";
import { useMapFocus } from "./mapFocus.ts";
import { SearchAreaButton } from "./MapPage.tsx";
import { setExploreIdx } from "./returnPoint.ts";
import { useAreaEntries, useSearchedArea } from "./useArea.ts";

/**
 * Explore on a desktop (DeskExplore.dc.html): the list beside the map (DeskLayout). The top bar,
 * which the shell draws, has the search and the toggle.
 *
 * Above the list are the filters, as menus, kept in the address the way the search keeps them, so
 * the phone's filters page and these read one model. Once the person moves the map, "Search this
 * area" lists the places where it is now, in both. Back to this page (from a place) finds the map
 * where it was, with that area.
 */
export function DeskExplore(): JSX.Element {
  useDocumentTitle(copy.titles.explore);
  const here = useHere();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();
  const filters = useMemo(() => filtersFromParams(params, locale), [params, locale]);
  const memoryKey = `desk:${historyKey}`;
  const searched = useSearchedArea(memoryKey);
  const { area } = searched;
  const { nearby, entries: filtered } = useAreaEntries(area, filters);
  const sort = sortInUse(filters);
  // The scores of the whole list, asked for in one go for the cards and the pins; best first when asked.
  const { entries, scores } = useListScores(filtered, sort === "score");
  // Opened at a place, from a phone's link to the map ("See on map").
  const focused = useMapFocus();

  // Where Explore is in the history, for the search's back arrow, as the phone's Explore records it:
  // as the page is drawn, before a link pressed meanwhile can move the history on.
  useLayoutEffect(() => {
    setExploreIdx(window.history.state?.idx);
  }, [historyKey]);

  // A filter is a step the Back button undoes, as on the search page.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next, locale));

  let instead: JSX.Element | undefined;
  if (nearby.length === 0) {
    instead = searched.fromMap ? <PageMessage>{copy.map.noneInArea}</PageMessage> : <NoneNearby />;
  } else if (entries.length === 0) {
    instead = (
      <PageMessage>
        {copy.search.noResultsFiltered(searched.fromMap ? copy.map.thisArea : here.label)} {copy.search.noResultsFilteredHint}
      </PageMessage>
    );
  }

  return (
    <DeskLayout
      title={copy.pages.explore}
      historyKey={historyKey}
      // A new filter, or a new area, is a new list, which starts from its first cards at its top.
      list={`desk|${params.toString()}|${area.lat}|${area.lon}|${area.radiusKm}`}
      head={
        <>
          {/* Explore has no words to match: its list is nearest first, by name, or best first by House picks. */}
          <FilterMenus
            filters={filters}
            order={sort === "name" || sort === "score" ? sort : "distance"}
            onChange={setFilters}
            locale={locale}
          />
          <HouseLine count={placeCount(entries)} unavailable={scores.house === "unavailable"} />
        </>
      }
      entries={entries}
      scores={scores}
      instead={instead}
      mapKey={memoryKey}
      focus={focused}
      onMoveEnd={searched.moved}
      overlay={(unselect) =>
        searched.canSearch && (
          <SearchAreaButton
            className="absolute top-[18px] left-1/2 -translate-x-1/2 px-[18px]"
            onClick={() => {
              unselect();
              searched.search();
            }}
          />
        )
      }
    />
  );
}
