import { type JSX, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Personalize } from "../circle/Personalize.tsx";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { placeCount } from "../places/indexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useScoreActions } from "../score/useScore.ts";
import { type Filters, filtersFromParams, sortInUse, widestKm, withFilters } from "../search/filters.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { PageMessage } from "../ui/Banner.tsx";
import { DeskLayout } from "./DeskLayout.tsx";
import { NoneNearby, ViewLine } from "./ExploreList.tsx";
import { FilterMenus } from "./FilterMenus.tsx";
import { useMapFocus } from "./mapFocus.ts";
import { SearchAreaButton } from "./MapPage.tsx";
import { setExploreIdx } from "./returnPoint.ts";
import { useAreaEntries, useSearchedArea } from "./useArea.ts";

/**
 * Explore on a desktop (DeskExplore.dc.html): the list beside the map (DeskLayout). The top bar,
 * which the shell draws, has the search and the toggle, whose My circle half opens Personalize in a
 * panel under it (Avi, 2026-10-08). Once the circle is asked for, the top of the list's column says how
 * it is getting on, for a person signed in whose circle is not ready, with Try again when it can't be had.
 *
 * Above the list are the filters, as menus, kept in the address the way the search keeps them, so
 * the phone's filters page and these read one model. The map has every place, at any zoom, whatever
 * the list holds (decision 25). Once the person moves the map, "Search this area" lists the places
 * in its box: the 50 nearest its middle, with how many the area has when there are more, in a polite
 * status so a screen reader hears it once the list has changed. The filters narrow the map as they
 * narrow the list (see `EveryPlaceMap`). Back to this
 * page (from a place) finds the map where it was, with that area.
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
  const { placesInArea, entries: filtered, inArea, nearestOnly, from } = useAreaEntries(area, filters);
  const sort = sortInUse(filters);
  // The scores of the whole list, asked for in one go for the cards and the pins; best first when asked.
  const { entries, scores } = useListScores(filtered, sort === "score");
  const { refresh } = useScoreActions();
  // What goes above the cards, which keeps the focus when Personalize's notice is put away.
  const head = useRef<HTMLDivElement>(null);
  // Opened at a place, from a phone's link to the map ("See on map").
  const focused = useMapFocus();
  // The map has every place, narrowed by the filters as the list is; a chosen pin's card beyond the
  // list measures its distance as the list does.
  const widest = filters.withinKm >= widestKm(locale);
  const everyPlace = useMemo(
    () => ({
      from,
      filters: {
        kinds: filters.families,
        within: { km: widest ? Number.POSITIVE_INFINITY : filters.withinKm, from },
        openNow: filters.open,
      },
    }),
    [from, filters, widest],
  );

  // Where Explore is in the history, for the search's back arrow, as the phone's Explore records it:
  // as the page is drawn, before a link pressed meanwhile can move the history on.
  useLayoutEffect(() => {
    setExploreIdx(window.history.state?.idx);
  }, [historyKey]);

  // A filter is a step the Back button undoes, as on the search page.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next, locale));

  // What the list is: its filters, and its area. A new one is a new list, which starts from its first
  // cards at its top, and whose count a screen reader hears; the minutes passing do not make one.
  const list = `desk|${params.toString()}|${area.lat}|${area.lon}|${area.box?.join(",") ?? area.radiusKm}`;

  let instead: JSX.Element | undefined;
  if (placesInArea === 0) {
    instead = searched.fromMap ? <PageMessage>{copy.map.noneInArea}</PageMessage> : <NoneNearby />;
  } else if (entries.length === 0 && nearestOnly === true) {
    // Open now stopped reading hours before it found an open place: there may be some farther out.
    instead = <PageMessage>{copy.deskExplore.noneOpenNearMiddle}</PageMessage>;
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
      list={list}
      head={
        <div ref={head} tabIndex={-1} className="flex flex-col gap-3.5 outline-none">
          {/* Under the top bar's toggle: the circle getting ready. The toggle itself offers Personalize. */}
          <Personalize holdFocus={head} offer="toggle" />
          {/* Explore has no words to match: its list is nearest first, by name, or best first by the view's scores. */}
          <FilterMenus
            filters={filters}
            order={sort === "name" || sort === "score" ? sort : "distance"}
            onChange={setFilters}
            locale={locale}
          />
          <ViewLine
            count={placeCount(entries)}
            inArea={inArea}
            nearestOnly={nearestOnly}
            // The places arriving are news too: the list's count is first said once they are in.
            announceKey={`${list}|${placesInArea}`}
            unavailable={scores.state === "unavailable"}
            onRetry={refresh}
            className="gap-3.5"
          />
        </div>
      }
      entries={entries}
      scores={scores}
      instead={instead}
      mapKey={memoryKey}
      focus={focused}
      everyPlace={everyPlace}
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
