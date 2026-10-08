import { type JSX, useEffect, useId, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { EmptyCircle } from "../circle/EmptyCircle.tsx";
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
import { PartOfChain } from "./PartOfChain.tsx";

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
 * Tapping a pin docks its place's card at the foot of the map, and the card opens the place; under
 * the card of one of a chain's places is the way to the chain. Tapping the map away from the pins
 * lets it go. A pin chosen from the keyboard moves the focus to its card. A card's distance is from
 * where the person is near: the device, when it has said where they are. The map has every place
 * wherever it is moved, so there is no area to search: Explore's list is the phone's list. Locate me
 * asks for the device's location, and goes back to it. Back to this page (from a place) finds the
 * map where it was.
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
  const { initialView, onViewChange } = useRememberedView(memoryKey);
  const indexes = useIndexes();
  // Opened at a place ("See on map"): the map starts there, unless it was left somewhere else, and its pin is chosen.
  const focused = useMapFocus();
  const [selected, setSelected] = useState(() => focused?.address);
  // The chosen pin's place, while there is one, and its score for its card.
  const chosen = useMemo<PlaceDistance[]>(() => {
    const place = selected === undefined ? undefined : indexes?.byAddress.get(selected);
    return place === undefined ? [] : [{ place, km: distanceKm(here.lat, here.lon, place.lat, place.lon) }];
  }, [selected, indexes, here.lat, here.lon]);
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
    if (here.source === "device") setRecentre((n) => n + 1);
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
            {chosen.map(({ place }) => (
              <PartOfChain
                key={place.address}
                place={place}
                className="mt-2 rounded-[12px] bg-ground px-3.5 shadow-float"
              />
            ))}
          </section>
        }
      >
        {/* 16 px in from the edges, as the design has them; between them the map can still be dragged. */}
        <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-col gap-2.5 *:pointer-events-auto">
          <SearchLink onMap />
          {/* The toggle and the line under it share one block: no gap is kept for a line that is not there. */}
          <div className="flex flex-col">
            <ViewSwitch variant="map" />
            <EmptyCircle className="*:mt-2.5 *:rounded-[12px] *:bg-ground *:px-3 *:py-2 *:shadow-float" />
          </div>
          <LocationNotice className="*:rounded-[12px] *:bg-ground *:px-3 *:py-2 *:shadow-float" />
        </div>
      </EveryPlaceMap>
    </div>
  );
}
