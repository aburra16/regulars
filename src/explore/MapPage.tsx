import { type JSX, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type LngLat } from "../map/BaseMap.tsx";
import { entryAddress, pinsFor } from "../map/pins.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { ChainCard } from "../ui/ChainCard.tsx";
import { LocateIcon } from "../ui/icons.tsx";
import { PlaceCard } from "../ui/PlaceCard.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { SearchLink } from "./ExploreList.tsx";
import { useAreaEntries, useSearchedArea } from "./useArea.ts";

/** The zoom a map opens at: a few streets each way. */
export const START_ZOOM = 13;

/** The dark button over the map that lists the places where the person has moved it (Map.dc.html, DeskExplore.dc.html). */
export function SearchAreaButton({ onClick, className = "" }: { onClick(): void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 cursor-pointer rounded-chip border-0 bg-ink font-text text-secondary font-bold text-ground shadow-map-button ${className}`}
    >
      {copy.map.searchArea}
    </button>
  );
}

/**
 * Explore, on the map (Map.dc.html; the phone's second tab). The map fills the screen above the
 * tabs, with the search field and the toggle floating at its top. Every place the list has is a
 * pin, a chain one pin at its nearest place, and pins that crowd are a bubble with a count.
 *
 * Tapping a pin docks its card at the foot of the map, and the card opens the place; tapping the
 * map away from the pins lets it go. Once the person moves the map, "Search this area" lists the
 * places where it is now. Locate me asks for the device's location, and goes back to it.
 *
 * A desktop shows the map beside the list on Explore, so there this page goes there.
 */
export function MapPage(): JSX.Element {
  useDocumentTitle(copy.titles.map);
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const searched = useSearchedArea();
  const { entries } = useAreaEntries(searched.area);
  const pins = useMemo(() => pinsFor(entries, locale, now), [entries, locale, now]);
  const [selected, setSelected] = useState<string>();
  const [recentre, setRecentre] = useState(0);
  const center = useMemo<LngLat>(() => [here.lon, here.lat], [here.lon, here.lat]);
  const you = useMemo<LngLat | undefined>(
    () => (here.source === "device" ? [here.lon, here.lat] : undefined),
    [here.source, here.lon, here.lat],
  );

  if (wide) return <Navigate to="/" replace />;

  // The chosen pin's place or chain, while it is still on the map.
  const chosen = selected === undefined ? undefined : entries.find((entry) => entryAddress(entry) === selected);

  const locate = () => {
    // Already found: back there now. The device is asked again either way, in case the person has moved.
    if (here.source === "device") {
      setRecentre((n) => n + 1);
      searched.reset();
    }
    here.useDevice();
  };

  let card: JSX.Element | undefined;
  if (chosen !== undefined) {
    card =
      "chain" in chosen ? (
        <ChainCard chain={chosen.chain} nearby={chosen.nearby} locale={locale} onMap />
      ) : (
        <PlaceCard place={chosen.place} km={chosen.km} variant="normal" locale={locale} now={now} onMap />
      );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">{copy.pages.map}</h1>
      <BaseMap
        className="min-h-0 flex-1"
        center={center}
        zoom={START_ZOOM}
        interactive
        pins={pins}
        selected={chosen === undefined ? undefined : selected}
        you={you}
        recentre={recentre}
        onSelect={setSelected}
        onMoveEnd={searched.moved}
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
        below={card}
      >
        {/* 16 px in from the edges, as the design has them; between them the map can still be dragged. */}
        <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-col gap-2.5 *:pointer-events-auto">
          <SearchLink onMap />
          <ViewSwitch variant="map" />
          <LocationNotice className="*:rounded-[12px] *:bg-ground *:px-3 *:py-2 *:shadow-float" />
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
      </BaseMap>
    </div>
  );
}
