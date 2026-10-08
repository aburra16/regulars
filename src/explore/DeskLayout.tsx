import { type JSX, type ReactNode, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useHere } from "../location/useLocation.ts";
import type { Bbox } from "../map/area.ts";
import { BaseMap, type ChosenBy, type LngLat } from "../map/BaseMap.tsx";
import { type Entry, pinsFor } from "../map/pins.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { shownPageOf } from "../ui/shown.ts";
import type { Place } from "../places/place.ts";
import { Entries } from "./Entries.tsx";
import { viewAt } from "./mapFocus.ts";
import { useRememberedView } from "./mapMemory.ts";
import { START_ZOOM } from "./MapPage.tsx";

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
  /** The person moved the map. */
  onMoveEnd?(bbox: Bbox): void;
  /** Over the map: "Search this area". `unselect` lets the chosen pin go, for a new list. */
  overlay?(unselect: () => void): ReactNode;
  /** A place to open at (`useMapFocus`): its pin chosen, and the map at it unless it was left somewhere else. */
  focus?: Place;
}

/**
 * The desktop's list beside its map (DeskExplore.dc.html): the column, 520 px wide, with what goes
 * above the cards, the cards, and the credit at its foot; the map filling the rest, the two showing
 * the same places. Explore and the search results are both this page (the brief's D1).
 *
 * Pointing at a card picks out its pin; clicking a pin brings its card into view with the dark edge,
 * and a pin chosen from the keyboard moves the focus to its card. The column keeps its scroll
 * position, and the map where it was, for Back.
 */
export function DeskLayout({
  title,
  historyKey,
  list,
  head,
  entries,
  instead,
  after,
  foot,
  mapKey,
  fit,
  onMoveEnd,
  overlay,
  focus,
}: DeskLayoutProps): JSX.Element {
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const { initialView, onViewChange } = useRememberedView(mapKey);
  const listId = useId();
  // Each pin chosen from the keyboard: the focus goes to its card in the list.
  const [focusRequest, setFocusRequest] = useState(0);
  const pins = useMemo(() => pinsFor(entries, locale, now), [entries, locale, now]);
  const [selected, setSelected] = useState(() => focus?.address);
  const [highlighted, setHighlighted] = useState<string>();
  const column = useRef<HTMLElement>(null);
  const center = useMemo<LngLat>(() => [here.lon, here.lat], [here.lon, here.lat]);
  const you = useMemo<LngLat | undefined>(
    () => (here.source === "device" ? [here.lon, here.lat] : undefined),
    [here.source, here.lon, here.lat],
  );

  useColumnScroll(column, historyKey, list);

  return (
    <div className="flex min-h-0 flex-1">
      <section
        ref={column}
        className="flex w-list shrink-0 flex-col gap-3.5 overflow-y-auto pt-[18px] pr-6 pb-6 pl-(--gutter-desktop)"
      >
        <h1 className="sr-only">{title}</h1>
        {head}
        {instead !== undefined ? (
          instead
        ) : (
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
        )}
        {after}
        <footer className="mt-auto flex flex-col gap-0.5 pt-1.5">
          {foot}
          <DetailsCredit />
        </footer>
      </section>
      <BaseMap
        className="min-w-0 flex-1"
        center={center}
        zoom={START_ZOOM}
        fit={fit}
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
        onMoveEnd={onMoveEnd}
        initialView={initialView ?? (focus === undefined ? undefined : viewAt(focus, START_ZOOM))}
        onViewChange={onViewChange}
        zoomButtons
      >
        {overlay?.(() => setSelected(undefined))}
      </BaseMap>
    </div>
  );
}
