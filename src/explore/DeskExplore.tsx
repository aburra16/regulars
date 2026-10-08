import { type JSX, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type ChosenBy, type LngLat } from "../map/BaseMap.tsx";
import { pinsFor } from "../map/pins.ts";
import { type Filters, filtersFromParams, withFilters } from "../search/filters.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { PageMessage } from "../ui/Banner.tsx";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { shownPageOf } from "../ui/shown.ts";
import { Entries } from "./Entries.tsx";
import { HouseLine, NoneNearby } from "./ExploreList.tsx";
import { FilterMenus } from "./FilterMenus.tsx";
import { useRememberedView } from "./mapMemory.ts";
import { SearchAreaButton, START_ZOOM } from "./MapPage.tsx";
import { setExploreIdx } from "./returnPoint.ts";
import { useAreaEntries, useSearchedArea } from "./useArea.ts";

/** Where the list kept its scroll position on each page of the history (`sessionStorage`), and on the tab's first page (memory: see `ShownPage`). */
const SCROLL_KEY = "regulars.desk.scroll";
const firstPageScroll = new Map<string, number>();

function readScroll(historyKey: string, list: string): number {
  if (historyKey === "default") return firstPageScroll.get(list) ?? 0;
  try {
    return Number(window.sessionStorage.getItem(`${SCROLL_KEY}:${historyKey}|${list}`)) || 0;
  } catch {
    return 0;
  }
}

function writeScroll(historyKey: string, list: string, top: number): void {
  if (historyKey === "default") {
    firstPageScroll.set(list, top);
    return;
  }
  try {
    window.sessionStorage.setItem(`${SCROLL_KEY}:${historyKey}|${list}`, String(top));
  } catch {
    // Blocked or full: Back to this page starts at the top of the list.
  }
}

/**
 * The list scrolls in its own column, beside the map, so the router's scroll restoration (which is
 * the window's) does not reach it. This keeps its place instead: a new page, or a new list, starts at
 * its top; Back to a page puts the list where it was.
 */
function useColumnScroll(column: RefObject<HTMLElement | null>, historyKey: string, list: string): void {
  useLayoutEffect(() => {
    const element = column.current;
    if (element === null) return;
    element.scrollTop = readScroll(historyKey, list);
    let top = element.scrollTop;
    const onScroll = () => {
      top = element.scrollTop;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      writeScroll(historyKey, list, top);
    };
  }, [column, historyKey, list]);
}

/**
 * Explore on a desktop (DeskExplore.dc.html): the list in a column 520 px wide, the map filling the
 * rest, the two showing the same places. The top bar, which the shell draws, has the search and the
 * toggle.
 *
 * Above the list are the filters, as menus, kept in the address the way the search keeps them, so
 * the phone's filters page and these read one model. Pointing at a card picks out its pin; clicking a
 * pin brings its card into view with the dark edge, and a pin chosen from the keyboard moves the
 * focus to its card. Once the person moves the map, "Search this area" lists the places where it is
 * now, in both. Back to this page (from a place) finds the map where it was, with that area.
 */
export function DeskExplore(): JSX.Element {
  useDocumentTitle(copy.titles.explore);
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();
  const filters = useMemo(() => filtersFromParams(params, locale), [params, locale]);
  const memoryKey = `desk:${historyKey}`;
  const searched = useSearchedArea(memoryKey);
  const { initialView, onViewChange } = useRememberedView(memoryKey);
  const listId = useId();
  // Each pin chosen from the keyboard: the focus goes to its card in the list.
  const [focusRequest, setFocusRequest] = useState(0);
  const { area } = searched;
  const { nearby, rows, entries } = useAreaEntries(area, filters);
  const pins = useMemo(() => pinsFor(entries, locale, now), [entries, locale, now]);
  const [selected, setSelected] = useState<string>();
  const [highlighted, setHighlighted] = useState<string>();
  const column = useRef<HTMLElement>(null);
  const center = useMemo<LngLat>(() => [here.lon, here.lat], [here.lon, here.lat]);
  const you = useMemo<LngLat | undefined>(
    () => (here.source === "device" ? [here.lon, here.lat] : undefined),
    [here.source, here.lon, here.lat],
  );

  // Where Explore is in the history, for the search's back arrow, as the phone's Explore records it.
  useEffect(() => {
    setExploreIdx(window.history.state?.idx);
  }, [historyKey]);

  // A filter is a step the Back button undoes, as on the search page.
  const setFilters = (next: Filters) => setParams((current) => withFilters(current, next, locale));

  // A new filter, or a new area, is a new list, which starts from its first cards at its top.
  const list = `desk|${params.toString()}|${area.lat}|${area.lon}|${area.radiusKm}`;
  useColumnScroll(column, historyKey, list);

  let body: JSX.Element;
  if (nearby.length === 0) {
    body = searched.fromMap ? <PageMessage>{copy.map.noneInArea}</PageMessage> : <NoneNearby />;
  } else if (entries.length === 0) {
    body = (
      <PageMessage>
        {copy.search.noResultsFiltered(searched.fromMap ? copy.map.thisArea : here.label)} {copy.search.noResultsFilteredHint}
      </PageMessage>
    );
  } else {
    body = (
      <Entries
        key={`${historyKey}|${list}`}
        page={shownPageOf(historyKey, list)}
        entries={entries}
        locale={locale}
        now={now}
        selected={selected}
        focusRequest={focusRequest}
        onHighlight={setHighlighted}
        listId={listId}
        scrollRoot={column}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section
        ref={column}
        className="flex w-list shrink-0 flex-col gap-3.5 overflow-y-auto pt-[18px] pr-6 pb-6 pl-(--gutter-desktop)"
      >
        <h1 className="sr-only">{copy.pages.explore}</h1>
        <FilterMenus filters={filters} onChange={setFilters} locale={locale} />
        <HouseLine count={rows.length} />
        {body}
        <footer className="mt-auto pt-1.5">
          <DetailsCredit />
        </footer>
      </section>
      <BaseMap
        className="min-w-0 flex-1"
        center={center}
        zoom={START_ZOOM}
        interactive
        pins={pins}
        selected={selected}
        highlighted={highlighted}
        you={you}
        onSelect={(address: string | undefined, by?: ChosenBy) => {
          setSelected(address);
          if (address !== undefined && by === "keyboard") setFocusRequest((n) => n + 1);
        }}
        pinsControl={listId}
        onMoveEnd={searched.moved}
        initialView={initialView}
        onViewChange={onViewChange}
        zoomButtons
      >
        {searched.canSearch && (
          <SearchAreaButton
            className="absolute top-[18px] left-1/2 -translate-x-1/2 px-[18px]"
            onClick={() => {
              setSelected(undefined);
              searched.search();
            }}
          />
        )}
      </BaseMap>
    </div>
  );
}
