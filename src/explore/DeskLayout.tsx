import { type JSX, type ReactNode, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useHere } from "../location/useLocation.ts";
import type { Bbox } from "../map/area.ts";
import { BaseMap, type BaseMapProps, type ChosenBy, type LngLat } from "../map/BaseMap.tsx";
import { type Entry, type Pin, pinsFor, scorePins } from "../map/pins.ts";
import { distanceKm } from "../places/distance.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import type { Place } from "../places/place.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { type ListScores, useListScores } from "../score/useListScores.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { shownPageOf } from "../ui/shown.ts";
import { Entries } from "./Entries.tsx";
import { EveryPlaceMap, type MapFilters } from "./EveryPlaceMap.tsx";
import { viewAt } from "./mapFocus.ts";
import { useRememberedView } from "./mapMemory.ts";
import { START_ZOOM } from "./MapPage.tsx";
import { PartOfChain } from "./PartOfChain.tsx";

const NO_PINS: readonly Pin[] = [];
const NO_ROWS: PlaceDistance[] = [];

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

export interface DeskLayoutProps {
  /** The page's name, for a screen reader: the column's heading. */
  title: string;
  /** The page of the history the layout is on (`useLocation().key`). */
  historyKey: string;
  /** What the list is (its filters, its area, its words): a new one starts at its top, with its first cards. */
  list: string;
  /** Above the cards: the filter menus, and the line under them. */
  head: ReactNode;
  /** The places and chains, as cards and as pins. */
  entries: Entry[];
  /** Their places' scores, which the page asked for in one go for the cards and the pins alike. */
  scores?: ListScores;
  /** In place of the cards, when there are none to show: what the page says instead (nothing near, nothing matches), or nothing. */
  instead?: ReactNode;
  /** Under the cards. */
  after?: ReactNode;
  /** At the foot of the column, above where the place details come from. */
  foot?: ReactNode;
  /** The map's page of the history, for where it is left (see mapMemory.ts). */
  mapKey: string;
  /** A box the map shows all of (see `BaseMap`'s `fit`); without one, it looks at where the person is near. */
  fit?: Bbox;
  /** The person moved the map: what it shows, and its centre. */
  onMoveEnd?(bbox: Bbox, centre: LngLat): void;
  /** Over the map: "Search this area". `unselect` lets the chosen pin go, for a new list. */
  overlay?(unselect: () => void): ReactNode;
  /** A place to open at (`useMapFocus`): its pin chosen, and the map at it unless it was left somewhere else. */
  focus?: Place;
  /**
   * Every place on the map, at any zoom, whatever the list holds (Explore; decision 25), in place of a
   * pin for each entry. A pin chosen whose place is not one of the list's own cards puts its place's
   * card at the top of the list, picked out, with how far it is from `from`, until it is let go.
   * `filters` narrow the map as the list's filters narrow the list (see `EveryPlaceMap`).
   */
  everyPlace?: { from: { lat: number; lon: number }; filters?: MapFilters };
}

/**
 * The desktop's list beside its map (DeskExplore.dc.html): the column, 520 px wide, with what goes
 * above the cards, the cards, and the credit at its foot; the map filling the rest, the two showing
 * the same places. Explore and the search results are both this page (the brief's D1).
 *
 * Pointing at a card picks out its pin; clicking a pin brings its card into view with the dark edge,
 * and a pin chosen from the keyboard moves the focus to its card. On Explore the map has every place
 * (`everyPlace`): a pin whose place the list does not hold as a card of its own (a place beyond the
 * list, or one of a chain's places, whose card is the chain's) has its place's card put at the top
 * of the list for as long as it is chosen, with the way to its chain under it when it is one of a
 * chain's. The column keeps its scroll position, and the map where it was, for Back.
 */
export function DeskLayout({
  title,
  historyKey,
  list,
  head,
  entries,
  scores,
  instead,
  after,
  foot,
  mapKey,
  fit,
  onMoveEnd,
  overlay,
  focus,
  everyPlace,
}: DeskLayoutProps): JSX.Element {
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const indexes = useIndexes();
  const { initialView, onViewChange } = useRememberedView(mapKey);
  const listId = useId();
  // Each pin chosen from the keyboard: the focus goes to its card in the list.
  const [focusRequest, setFocusRequest] = useState(0);
  // A pin for each entry, unless the map has every place. The pins' hours are worked out when the
  // places or the minute change; their scores, when the scores do.
  const pinEach = everyPlace === undefined;
  const unscored = useMemo(() => (pinEach ? pinsFor(entries, locale, now) : NO_PINS), [pinEach, entries, locale, now]);
  const pins = useMemo(() => (scores === undefined ? unscored : scorePins(unscored, scores.of)), [unscored, scores]);
  const [selected, setSelected] = useState(() => focus?.address);

  // On a map of every place, the chosen pin's place when the list has no card of its own for it: its
  // card goes at the top of the list, with its score, asked for on its own.
  const fromLat = everyPlace?.from.lat;
  const fromLon = everyPlace?.from.lon;
  const outside = useMemo<PlaceDistance[]>(() => {
    if (fromLat === undefined || fromLon === undefined || selected === undefined) return NO_ROWS;
    if (entries.some((entry) => !("chain" in entry) && entry.place.address === selected)) return NO_ROWS;
    const place = indexes?.byAddress.get(selected);
    return place === undefined ? NO_ROWS : [{ place, km: distanceKm(fromLat, fromLon, place.lat, place.lon) }];
  }, [fromLat, fromLon, selected, entries, indexes]);
  const { scores: outsideScores } = useListScores(outside);
  const [first] = outside;
  const cardScores = useMemo<ListScores | undefined>(() => {
    if (first === undefined) return scores;
    const { address } = first.place;
    const listed = scores ?? outsideScores;
    return { ...listed, of: (each) => (each === address ? outsideScores.of(each) : listed.of(each)) };
  }, [first, scores, outsideScores]);
  const [highlighted, setHighlighted] = useState<string>();
  const column = useRef<HTMLElement>(null);
  const center = useMemo<LngLat>(() => [here.lon, here.lat], [here.lon, here.lat]);
  const you = useMemo<LngLat | undefined>(
    () => (here.source === "device" ? [here.lon, here.lat] : undefined),
    [here.source, here.lon, here.lat],
  );

  useColumnScroll(column, historyKey, list);

  // The map, beside the list: a pin for each entry, or every place.
  const map: BaseMapProps = {
    className: "min-w-0 flex-1",
    center,
    zoom: START_ZOOM,
    fit,
    interactive: true,
    selected,
    highlighted,
    you,
    onSelect: (address: string | undefined, by?: ChosenBy) => {
      setSelected(address);
      if (address !== undefined && by === "keyboard") setFocusRequest((n) => n + 1);
    },
    pinsControl: listId,
    onMoveEnd,
    initialView: initialView ?? (focus === undefined ? undefined : viewAt(focus, START_ZOOM)),
    onViewChange,
    zoomButtons: true,
    children: overlay?.(() => setSelected(undefined)),
  };

  return (
    <div className="flex min-h-0 flex-1">
      <section
        ref={column}
        className="flex w-list shrink-0 flex-col gap-3.5 overflow-y-auto pt-[18px] pr-6 pb-6 pl-(--gutter-desktop)"
      >
        <h1 className="sr-only">{title}</h1>
        {head}
        {/* The cards; or, with nothing to list, only the chosen pin's card, above what the page says instead. */}
        {(instead === undefined || first !== undefined) && (
          <Entries
            key={`${historyKey}|${list}`}
            page={shownPageOf(historyKey, list)}
            entries={instead === undefined ? entries : []}
            first={first}
            afterFirst={first !== undefined && <PartOfChain place={first.place} className="mt-1" />}
            locale={locale}
            now={now}
            selected={selected}
            focusRequest={focusRequest}
            onHighlight={setHighlighted}
            listId={listId}
            scrollRoot={column}
            scores={cardScores}
          />
        )}
        {instead}
        {after}
        <footer className="mt-auto flex flex-col gap-0.5 pt-1.5">
          {foot}
          <DetailsCredit />
        </footer>
      </section>
      {everyPlace === undefined ? <BaseMap {...map} pins={pins} /> : <EveryPlaceMap {...map} filters={everyPlace.filters} />}
    </div>
  );
}
