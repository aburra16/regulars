import type { Point } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import { type JSX, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import starSvg from "../assets/icons/star.svg?raw";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { kindOf } from "../places/kinds.ts";
import { Attribution } from "../ui/Attribution.tsx";
import { MinusIcon, PlusIcon } from "../ui/icons.tsx";
import { FamilyIcon } from "../ui/KindTile.tsx";
import type { Bbox } from "./area.ts";
import { CLUSTER_OPTIONS, MAX_MARKERS, type Pin, PIN_SOURCE, pinsGeoJSON } from "./pins.ts";
import { mapStyle, recolour } from "./style.ts";

export type { Pin } from "./pins.ts";

/** A point on the map as MapLibre takes one: longitude, then latitude. */
export type LngLat = [lon: number, lat: number];

export interface BaseMapProps {
  /** Where the map looks, longitude first. A new centre moves the map there. */
  center: LngLat;
  zoom: number;
  /** Whether the person can move the map and tap its pins. A map that is not is a picture of where a place is. */
  interactive: boolean;
  pins?: readonly Pin[];
  /** The address of the chosen pin: drawn in the accent colour, and pressed. */
  selected?: string;
  /** The address of a pin to pick out, as the card of it is pointed at: drawn in the accent colour. */
  highlighted?: string;
  /** Where the person is, when the device has said: the blue dot. */
  you?: LngLat;
  /** Change it to move the map back to `center` when `center` itself has not changed (Locate me, pressed again). */
  recentre?: number;
  /**
   * A pin was tapped: its address. Undefined: the map was tapped away from any pin, which lets the
   * chosen one go.
   */
  onSelect?(address: string | undefined): void;
  /** The person moved the map (a drag, a pinch, the wheel, the keys, the zoom buttons): what it shows now. Not called for moves the page makes. */
  onMoveEnd?(bbox: Bbox): void;
  /** The zoom buttons, at the bottom right (DeskExplore.dc.html). */
  zoomButtons?: boolean;
  /** At the bottom right, above the zoom buttons and the attribution: the page's own controls. */
  corner?: ReactNode;
  /** Below the attribution, the width of the map: the phone's docked card (Map.dc.html). */
  below?: ReactNode;
  /** Over the map, placed by the page: the search field, "Search this area". */
  children?: ReactNode;
  /** Sizes and places the map. */
  className?: string;
}

type Library = typeof import("./maplibre.ts");

/** What the map has drawn of the pins: a pin on its own, or a bubble of pins too close together to tell apart. */
type Seen =
  | { key: string; address: string }
  | { key: string; cluster: { id: number; count: number }; lngLat: LngLat };

/** A marker on the map: a pin, a bubble, or where the person is. */
type Item =
  | { key: string; kind: "pin"; lngLat: LngLat; pin: Pin }
  | { key: string; kind: "cluster"; lngLat: LngLat; id: number; count: number }
  | { key: string; kind: "you"; lngLat: LngLat };

const NO_PINS: readonly Pin[] = [];

/** "61", "1.2K": a count that fits its bubble. */
const compactCount = new Intl.NumberFormat("en", { notation: "compact" });

/** A move a person made: one that came from their input, or from the zoom buttons. */
const byPerson = (event: { originalEvent?: unknown; byPerson?: unknown }) =>
  event.originalEvent !== undefined || event.byPerson === true;

/**
 * The pins and bubbles a source has in its tiles, once each, in reading order: north to south,
 * then west to east, which is the order the keyboard reaches them in. Past `MAX_MARKERS`, only
 * those in view, as many as that.
 */
function seenOf(map: MapLibreMap): Seen[] {
  const all: (Seen & { lngLat: LngLat })[] = [];
  const keys = new Set<string>();
  for (const feature of map.querySourceFeatures(PIN_SOURCE)) {
    const props = feature.properties ?? {};
    const lngLat = (feature.geometry as Point).coordinates as LngLat;
    let seen: Seen & { lngLat: LngLat };
    if (props.cluster) {
      const id = Number(props.cluster_id);
      seen = { key: `cluster:${id}`, cluster: { id, count: Number(props.point_count) }, lngLat };
    } else if (typeof props.address === "string") {
      seen = { key: `pin:${props.address}`, address: props.address, lngLat };
    } else {
      continue;
    }
    // A point on the edge of a tile is in both tiles.
    if (keys.has(seen.key)) continue;
    keys.add(seen.key);
    all.push(seen);
  }
  let kept = all;
  if (all.length > MAX_MARKERS) {
    const bounds = map.getBounds();
    kept = all.filter((seen) => bounds.contains(seen.lngLat)).slice(0, MAX_MARKERS);
  }
  return kept.sort((a, b) => b.lngLat[1] - a.lngLat[1] || a.lngLat[0] - b.lngLat[0]);
}

/** The pins as a signature: the same places at the same points are the same data, whatever their names say. */
const signatureOf = (pins: readonly Pin[]) => pins.map((pin) => `${pin.address}@${pin.lon},${pin.lat}`).join("\n");

/** The star of a score's pin, in the pin's text colour. */
function Star({ className }: { className: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`block shrink-0 [&>svg]:size-full ${className}`}
      // Safe: the text is our own icon file, bundled at build time, never data from outside.
      dangerouslySetInnerHTML={{ __html: starSvg }}
    />
  );
}

/**
 * A pin, as Map.dc.html draws it: a ring for a place with no score, a pill with its star and score
 * for one with a score, a pill with the kind's icon and "×3" for a chain. In the accent colour when
 * chosen or picked out. A 44 px target around each.
 */
function PinMark({
  pin,
  accent,
  selected,
  onSelect,
}: {
  pin: Pin;
  accent: boolean;
  selected: boolean;
  onSelect: ((address: string) => void) | undefined;
}): JSX.Element {
  let look: JSX.Element;
  let box: string;
  if (pin.chainCount !== undefined) {
    box = "h-11 py-1.5";
    look = (
      <span
        className={`inline-flex h-8 items-center gap-[5px] rounded-[16px] px-2.5 font-text text-caption font-bold whitespace-nowrap shadow-pin ${
          accent ? "bg-accent text-on-accent" : "bg-ground text-ink"
        }`}
      >
        {pin.category !== undefined && <FamilyIcon family={kindOf(pin.category).family} className="size-[15px]" />}
        {copy.map.chainCount(pin.chainCount)}
      </span>
    );
  } else if (pin.label !== undefined) {
    box = accent ? "h-12 py-1" : "h-11 py-1.5";
    look = (
      <span
        className={`inline-flex items-center font-text whitespace-nowrap ${
          accent
            ? "h-10 gap-[5px] rounded-[20px] bg-accent px-3.5 text-body font-extrabold text-on-accent shadow-pin-chosen"
            : "h-8 gap-1 rounded-[16px] bg-ground px-2.5 text-secondary font-bold text-ink shadow-pin"
        }`}
      >
        <Star className={accent ? "size-3.5 text-on-accent" : "size-[13px] text-accent"} />
        {pin.label}
      </span>
    );
  } else {
    box = "size-11 justify-center";
    look = (
      <span
        className={`box-border block rounded-full border-4 bg-ground shadow-pin-ring ${
          accent ? "size-[22px] border-accent" : "size-[18px] border-muted"
        }`}
      />
    );
  }
  const className = `flex items-center border-0 bg-transparent p-0 ${box}`;
  if (onSelect === undefined) {
    return (
      <span aria-hidden="true" className={className}>
        {look}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={pin.name}
      aria-pressed={selected}
      onClick={() => onSelect(pin.address)}
      className={`cursor-pointer ${className}`}
    >
      {look}
    </button>
  );
}

/** The two zoom buttons, as DeskExplore.dc.html draws them: one white block, a line between. */
function ZoomButtons({ onZoom }: { onZoom(direction: "in" | "out"): void }): JSX.Element {
  const button = "flex size-11 cursor-pointer items-center justify-center border-0 bg-ground p-0 text-ink";
  return (
    <div className="flex flex-col overflow-hidden rounded-tile bg-ground shadow-map-controls">
      <button type="button" aria-label={copy.map.zoomIn} onClick={() => onZoom("in")} className={`${button} border-b-token border-line`}>
        <PlusIcon size={20} />
      </button>
      <button type="button" aria-label={copy.map.zoomOut} onClick={() => onZoom("out")} className={button}>
        <MinusIcon size={20} />
      </button>
    </div>
  );
}

/**
 * A map: MapTiler's tiles in the tokens' colours, or a plain ground when there is no key; the pins,
 * gathered into bubbles where they crowd; where the person is; and "© MapTiler © OpenStreetMap
 * contributors" at the bottom right, on every map.
 *
 * MapLibre is loaded when the first map is drawn, from a chunk of its own. The map is made once, and
 * removed when this goes; a change of pins changes the map's data, and a change of centre moves it.
 * Each pin is a button, drawn by React into a marker of the map's own, so it has a name a screen
 * reader can read and a place in the keyboard's order.
 */
export function BaseMap({
  center,
  zoom,
  interactive,
  pins = NO_PINS,
  selected,
  highlighted,
  you,
  recentre,
  onSelect,
  onMoveEnd,
  zoomButtons = false,
  corner,
  below,
  children,
  className = "",
}: BaseMapProps): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libraryRef = useRef<Library | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState<Seen[]>([]);

  // What the map's handlers read when they run: the latest of each, not those it was made with.
  const latest = useRef({ center, zoom, interactive, pins, onSelect, onMoveEnd });
  useLayoutEffect(() => {
    latest.current = { center, zoom, interactive, pins, onSelect, onMoveEnd };
  });

  // Each marker's element, made when it is first drawn, and the marker that puts it on the map.
  const elements = useRef(new Map<string, HTMLDivElement>());
  const markers = useRef(new Map<string, Marker>());
  const elementFor = (key: string): HTMLDivElement => {
    let element = elements.current.get(key);
    if (element === undefined) {
      element = document.createElement("div");
      elements.current.set(key, element);
    }
    return element;
  };

  // The data the map's source holds, so the same pins are not sent again.
  const applied = useRef<string | null>(null);

  // Make the map, once.
  useEffect(() => {
    let cancelled = false;
    let made: MapLibreMap | undefined;
    const ownMarkers = markers.current;
    import("./maplibre.ts").then(
      (library) => {
        if (cancelled || container.current === null) return;
        const { center: at, zoom: level, interactive: canMove } = latest.current;
        const style = mapStyle(config.mapTilerKey);
        let map: MapLibreMap;
        try {
          map = new library.Map({
            container: container.current,
            style,
            center: at,
            zoom: level,
            interactive: canMove,
            attributionControl: false,
            locale: { "Map.Title": copy.map.label },
          });
        } catch {
          // A browser that cannot draw a map (no WebGL). The page goes on without one.
          setFailed(true);
          return;
        }
        made = map;
        mapRef.current = map;
        libraryRef.current = library;

        const look = () => {
          if (map.getSource(PIN_SOURCE) === undefined || !map.isSourceLoaded(PIN_SOURCE)) return;
          const next = seenOf(map);
          setSeen((current) =>
            current.length === next.length && current.every((each, i) => each.key === next[i]!.key) ? current : next,
          );
        };

        let styled = false;
        let fellBack = false;
        map.on("error", (event: { sourceId?: string; error?: unknown }) => {
          // Handled here, so MapLibre does not write each one to the console. A tile that does not
          // come (the network is gone) leaves a gap that the next move fills.
          if (import.meta.env.DEV) console.warn(event.error);
          // The style itself did not come: the plain ground instead, so the pins still have a map.
          if (!styled && !fellBack && typeof style === "string" && event.sourceId === undefined) {
            fellBack = true;
            map.setStyle(mapStyle(undefined));
          }
        });

        // As soon as the style is there, before its tiles: the tokens' colours, so MapTiler's own
        // greys are never drawn, and the pins. A new style (the plain one, after MapTiler's failed)
        // has neither, so each style gets both.
        const setUp = () => {
          styled = true;
          recolour(map);
          if (map.getSource(PIN_SOURCE) === undefined) {
            const { pins: now } = latest.current;
            map.addSource(PIN_SOURCE, { type: "geojson", data: pinsGeoJSON(now), ...CLUSTER_OPTIONS });
            // Drawn by no one: the markers draw the pins. Without a layer the source would load no tiles to read them from.
            map.addLayer({
              id: PIN_SOURCE,
              type: "circle",
              source: PIN_SOURCE,
              paint: { "circle-radius": 0, "circle-opacity": 0, "circle-stroke-width": 0 },
            });
            applied.current = signatureOf(now);
          }
          setReady(true);
          look();
        };
        map.on("style.load", setUp);
        // The map is drawn, its first tiles in. Only if the style came without saying so.
        map.on("load", () => {
          if (map.getSource(PIN_SOURCE) === undefined) setUp();
        });
        // Each frame, which pins and bubbles are drawn. Nothing changes on screen unless that does.
        map.on("render", look);

        let personMoving = false;
        map.on("movestart", (event: { originalEvent?: unknown; byPerson?: unknown }) => {
          personMoving = byPerson(event);
        });
        map.on("moveend", (event: { originalEvent?: unknown; byPerson?: unknown }) => {
          const moved = personMoving || byPerson(event);
          personMoving = false;
          if (!moved) return;
          const bounds = map.getBounds();
          latest.current.onMoveEnd?.([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
        });

        map.on("click", (event: { originalEvent?: Event }) => {
          // A tap on a pin is the pin's: its button says what it is.
          const target = event.originalEvent?.target;
          if (target instanceof Node && [...elements.current.values()].some((element) => element.contains(target))) return;
          latest.current.onSelect?.(undefined);
        });
      },
      () => {
        // The map's code could not be loaded (the network is gone on a first visit).
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      made?.remove();
      mapRef.current = null;
      ownMarkers.clear();
    };
  }, []);

  // New pins: new data for the map, which gathers them again.
  const signature = useMemo(() => signatureOf(pins), [pins]);
  useEffect(() => {
    if (!ready || applied.current === signature) return;
    const source = mapRef.current?.getSource<GeoJSONSource>(PIN_SOURCE);
    if (source === undefined) return;
    applied.current = signature;
    source.setData(pinsGeoJSON(pins));
    // `pins` goes with `signature`, which says when they are new.
  }, [ready, signature]);

  // A new centre, or the same one asked for again: move there. The map is made at the first.
  const [lon, lat] = center;
  const placed = useRef<{ lon: number; lat: number; recentre: number | undefined } | null>(null);
  useEffect(() => {
    const last = placed.current;
    placed.current = { lon, lat, recentre };
    const map = mapRef.current;
    if (last === null || map === null) return;
    if (last.lon === lon && last.lat === lat && last.recentre === recentre) return;
    map.easeTo({ center: [lon, lat], zoom });
    // The zoom is where to land, read when the move starts; a new zoom alone is not a move.
  }, [lon, lat, recentre]);

  // What to draw: what the map shows of the pins, the chosen and picked-out pins wherever they are
  // (a pin inside a bubble too), and where the person is.
  const byAddress = useMemo(() => new Map(pins.map((pin) => [pin.address, pin])), [pins]);
  const [youLon, youLat] = you ?? [];
  const items = useMemo(() => {
    const list: Item[] = [];
    const drawn = new Set<string>();
    const add = (pin: Pin) => {
      drawn.add(pin.address);
      list.push({ key: `pin:${pin.address}`, kind: "pin", lngLat: [pin.lon, pin.lat], pin });
    };
    for (const each of seen) {
      if ("cluster" in each) {
        list.push({ key: each.key, kind: "cluster", lngLat: each.lngLat, ...each.cluster });
      } else {
        const pin = byAddress.get(each.address);
        if (pin !== undefined) add(pin);
      }
    }
    for (const address of [selected, highlighted]) {
      const pin = address === undefined || drawn.has(address) ? undefined : byAddress.get(address);
      if (pin !== undefined) add(pin);
    }
    if (youLon !== undefined && youLat !== undefined) list.push({ key: "you", kind: "you", lngLat: [youLon, youLat] });
    return list;
  }, [seen, byAddress, selected, highlighted, youLon, youLat]);

  // Put each marker on the map, and take off those that have gone. The chosen pin sits on top.
  useEffect(() => {
    const map = mapRef.current;
    const library = libraryRef.current;
    if (map === null || library === null) return;
    const wanted = new Set(items.map((item) => item.key));
    for (const [key, marker] of markers.current) {
      if (wanted.has(key)) continue;
      marker.remove();
      markers.current.delete(key);
      elements.current.delete(key);
    }
    for (const item of items) {
      const element = elementFor(item.key);
      const marker = markers.current.get(item.key);
      if (marker === undefined) {
        markers.current.set(item.key, new library.Marker({ element, anchor: "center" }).setLngLat(item.lngLat).addTo(map));
      } else {
        marker.setLngLat(item.lngLat);
      }
      const onTop = item.kind === "pin" && (item.pin.address === selected || item.pin.address === highlighted);
      element.style.zIndex = onTop ? "1" : "";
    }
  }, [items, ready, selected, highlighted]);

  const zoomInto = async (id: number, lngLat: LngLat) => {
    const map = mapRef.current;
    const source = map?.getSource<GeoJSONSource>(PIN_SOURCE);
    if (!map || source === undefined) return;
    try {
      const level = await source.getClusterExpansionZoom(id);
      if (mapRef.current === map) map.easeTo({ center: lngLat, zoom: level });
    } catch {
      // The bubble has gone (the pins changed under it): there is nothing to open.
    }
  };

  const zoomBy = (direction: "in" | "out") => {
    const map = mapRef.current;
    // Marked as the person's own move, as a drag is, so the page can offer to search what it shows.
    if (direction === "in") map?.zoomIn(undefined, { byPerson: true });
    else map?.zoomOut(undefined, { byPerson: true });
  };

  const canTap = interactive && onSelect !== undefined;

  return (
    <div className={`relative overflow-hidden bg-map-land ${className}`}>
      {/* MapLibre's styles make its container `position: relative`, and they win over a class here: its
          box fills one that is placed. */}
      <div className="absolute inset-0">
        <div ref={container} className="size-full" />
      </div>
      {failed && (
        <p className="absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-secondary text-muted">
          {copy.map.failed}
        </p>
      )}
      {children}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col items-end gap-2 wide:inset-x-4 wide:bottom-4 wide:gap-2.5 *:pointer-events-auto">
        {corner}
        {zoomButtons && interactive && <ZoomButtons onZoom={zoomBy} />}
        <Attribution kind="map" />
        {below !== undefined && <div className="self-stretch">{below}</div>}
      </div>
      {items.map((item) => {
        let mark: JSX.Element;
        if (item.kind === "you") {
          mark = (
            <span
              role="img"
              aria-label={copy.map.youAreHere}
              className="box-border block size-5 rounded-full border-4 border-ground bg-you-are-here shadow-you-are-here"
            />
          );
        } else if (item.kind === "cluster") {
          const look =
            "flex h-12 min-w-12 items-center justify-center rounded-full border-[3px] border-ground bg-ink px-1 font-text text-body font-extrabold text-ground shadow-pin";
          mark = canTap ? (
            <button
              type="button"
              aria-label={copy.map.cluster(item.count)}
              onClick={() => void zoomInto(item.id, item.lngLat)}
              className={`cursor-pointer ${look}`}
            >
              {compactCount.format(item.count)}
            </button>
          ) : (
            <span aria-hidden="true" className={look}>
              {compactCount.format(item.count)}
            </span>
          );
        } else {
          const { address } = item.pin;
          mark = (
            <PinMark
              pin={item.pin}
              accent={address === selected || address === highlighted}
              selected={address === selected}
              onSelect={canTap ? (tapped) => latest.current.onSelect?.(tapped) : undefined}
            />
          );
        }
        return createPortal(mark, elementFor(item.key), item.key);
      })}
    </div>
  );
}
