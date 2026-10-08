import { type JSX, useEffect, useId, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { useHere } from "../location/useLocation.ts";
import type { ChosenBy, LngLat } from "../map/BaseMap.tsx";
import { distanceKm } from "../places/distance.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { LocateIcon } from "../ui/icons.tsx";
import { PlaceCard } from "../ui/PlaceCard.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { EveryPlaceMap } from "./EveryPlaceMap.tsx";
import { SearchLink } from "./ExploreList.tsx";
import { mapFocusOn, useMapFocus, viewAt } from "./mapFocus.ts";
import { useRememberedView } from "./mapMemory.ts";
import { useAreaEntries, useSearchedArea } from "./useArea.ts";

/** The zoom a map opens at: a few streets each way. */
export const START_ZOOM = 13;

/** The dark button over the map that lists the places where the person has moved it (Map.dc.html, DeskExplore.dc.html). */
export function SearchAreaButton({ onClick, className = "" }: { onClick(): void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pointer-events-auto h-11 cursor-pointer rounded-chip border-0 bg-emphasis font-text text-secondary font-bold text-on-emphasis shadow-map-button ${className}`}
    >
      {copy.map.searchArea}
    </button>
  );
}

/**
 * Explore, on the map (Map.dc.html; the phone's second tab). The map fills the screen above the
 * tabs, with the search field and the toggle floating at its top. Every place is a pin, at any zoom
 * (decision 25), a chain's places each on their own, and pins that crowd are a bubble with a count.
 *
 * Tapping a pin docks its place's card at the foot of the map, and the card opens the place; tapping
 * the map away from the pins lets it go. A pin chosen from the keyboard moves the focus to its card.
 * Once the person moves the map, "Search this area" makes it where the page is near: a card's
 * distance is from the middle of the map then, unless the device has said where the person is, and
 * the page says so when there are no places there. Locate me asks for the device's location, and
 * goes back to it. Back to this page (from a place) finds the map where it was, with the area that
 * was searched.
 *
 * A desktop shows the map beside the list on Explore, so there this page goes there.
 */
export function MapPage(): JSX.Element {
  useDocumentTitle(copy.titles.map);
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const { key: historyKey } = useLocation();
  const memoryKey = `map:${historyKey}`;
  const searched = useSearchedArea(memoryKey);
  const { initialView, onViewChange } = useRememberedView(memoryKey);
  // The map has every place: the area says whether a searched one has any, and where distances are from.
  const { nearby, from } = useAreaEntries(searched.area);
  const indexes = useIndexes();
  // Opened at a place ("See on map"): the map starts there, unless it was left somewhere else, and its pin is chosen.
  const focused = useMapFocus();
  const [selected, setSelected] = useState(() => focused?.address);
  // The chosen pin's place, while there is one, and its score for its card.
  const chosen = useMemo<PlaceDistance[]>(() => {
    const place = selected === undefined ? undefined : indexes?.byAddress.get(selected);
    return place === undefined ? [] : [{ place, km: distanceKm(from.lat, from.lon, place.lat, place.lon) }];
  }, [selected, indexes, from]);
  const { scores } = useListScores(chosen);
  const [recentre, setRecentre] = useState(0);
  const cardId = useId();
  // Each pin chosen from the keyboard: the focus goes to its card once the card is drawn.
  const [focusCard, setFocusCard] = useState(0);
  useEffect(() => {
    if (focusCard > 0) document.getElementById(cardId)?.querySelector("a")?.focus();
  }, [focusCard, cardId]);
  const center = useMemo<LngLat>(() => [here.lon, here.lat], [here.lon, here.lat]);
  const you = useMemo<LngLat | undefined>(
    () => (here.source === "device" ? [here.lon, here.lat] : undefined),
    [here.source, here.lon, here.lat],
  );

  // A desktop has the map on Explore, opened at the same place.
  if (wide) return <Navigate to="/" replace state={focused === undefined ? undefined : mapFocusOn(focused)} />;

  const choose = (address: string | undefined, by?: ChosenBy) => {
    setSelected(address);
    if (address !== undefined && by === "keyboard") setFocusCard((n) => n + 1);
  };

  const locate = () => {
    // Already found: back there now. The device is asked again either way, in case the person has moved.
    if (here.source === "device") {
      setRecentre((n) => n + 1);
      searched.reset();
    }
    here.useDevice();
  };

  const [card] = chosen.map(({ place, km }) => (
    <PlaceCard place={place} km={km} variant="normal" score={scores.of(place.address)} locale={locale} now={now} onMap />
  ));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">{copy.pages.map}</h1>
      <EveryPlaceMap
        className="min-h-0 flex-1"
        center={center}
        zoom={START_ZOOM}
        interactive
        selected={card === undefined ? undefined : selected}
        you={you}
        recentre={recentre}
        onSelect={choose}
        pinsControl={cardId}
        onMoveEnd={searched.moved}
        initialView={initialView ?? (focused === undefined ? undefined : viewAt(focused, START_ZOOM))}
        onViewChange={onViewChange}
        corner={
          <button
            type="button"
            aria-label={copy.location.useMine}
            aria-busy={here.pending}
            onClick={locate}
            className="flex size-11 cursor-pointer items-center justify-center rounded-tile border-0 bg-ground p-0 text-ink shadow-map-controls"
          >
            <LocateIcon size={22} />
          </button>
        }
        below={
          // Always on the page, so each pin can name it as what it opens; hidden while nothing is chosen.
          <section id={cardId} aria-label={copy.map.selected} hidden={card === undefined}>
            {card}
          </section>
        }
      >
        {/* 16 px in from the edges, as the design has them; between them the map can still be dragged. */}
        <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-col gap-2.5 *:pointer-events-auto">
          <SearchLink onMap />
          <ViewSwitch variant="map" />
          <LocationNotice className="*:rounded-[12px] *:bg-ground *:px-3 *:py-2 *:shadow-float" />
          {/* Always there, so a screen reader hears when a search of the map finds nothing. */}
          <div role="status" className="*:m-0 *:rounded-[12px] *:bg-ground *:px-3 *:py-2 *:text-secondary *:text-ink-soft *:shadow-float">
            {searched.fromMap && nearby.length === 0 && <p>{copy.map.noneInArea}</p>}
          </div>
          {searched.canSearch && (
            <SearchAreaButton
              className="mt-0.5 w-40 self-center"
              onClick={() => {
                setSelected(undefined);
                searched.search();
              }}
            />
          )}
        </div>
      </EveryPlaceMap>
    </div>
  );
}
