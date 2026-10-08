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

/** Where a map looks, and how far in. */
export interface MapView {
  center: LngLat;
  zoom: number;
}

/** How a pin was chosen: from the keyboard (Enter or Space), or by a tap or a click. */
export type ChosenBy = "keyboard" | "pointer";

export interface BaseMapProps {
  /** Where the map looks, longitude first. A new centre moves the map there. */
  center: LngLat;
  zoom: number;
  /**
   * A box the map shows all of (the results of a search): it takes the place of `center` and `zoom`
   * while it is given. The map starts on it, unless `initialView` says where it was left, and moves
   * to each new box.
   */
  fit?: Bbox;
  /** Whether the person can move the map and tap its pins. A map that is not is a picture of where a place is. */
  interactive: boolean;
  /**
   * A map that does not move, to a screen reader: one picture with this name ("Map showing where
   * Jacafé is"), in place of the map's own region, which it hides. Its attribution stays reachable.
   */
  label?: string;
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
   * A pin was chosen: its address, and whether from the keyboard, when the page moves the focus to
   * what the pin opens. Undefined: the map was tapped away from any pin, which lets the chosen one go.
   */
  onSelect?(address: string | undefined, by?: ChosenBy): void;
  /** The id of what a chosen pin opens (the docked card, the list): each pin says it controls it. */
  pinsControl?: string;
  /** The person moved the map (a drag, a pinch, the wheel, the keys, the zoom buttons): what it shows now. Not called for moves the page makes. */
  onMoveEnd?(bbox: Bbox): void;
  /** Where the map starts, when it is not `center` at `zoom`: where it was left, on Back. */
  initialView?: MapView;
  /** After every move, the person's or the page's: where the map looks now. */
  onViewChange?(view: MapView): void;
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
  | { key: string; address: string; lngLat: LngLat }
  | { key: string; cluster: { id: number; count: number }; lngLat: LngLat };

/** What the map shows: its pins and bubbles, and which of them, and of the pins picked out, are in view (by key). */
interface Shown {
  items: Seen[];
  inView: ReadonlySet<string>;
  /** The pin the source was without when these were read (the chosen one, drawn on its own then). */
  without?: string;
}

const NOTHING_SHOWN: Shown = { items: [], inView: new Set() };

/** A marker on the map: a pin, a bubble, or where the person is. */
type Item =
  | { key: string; kind: "pin"; lngLat: LngLat; pin: Pin }
  | { key: string; kind: "cluster"; lngLat: LngLat; id: number; count: number }
  | { key: string; kind: "you"; lngLat: LngLat };

const NO_PINS: readonly Pin[] = [];

/** How a map fits a box: the pins at its edge still clear of the map's edge, and no closer than a street. */
const FIT_OPTIONS = { padding: 60, maxZoom: 15 } as const;

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
  const all: Seen[] = [];
  const keys = new Set<string>();
  for (const feature of map.querySourceFeatures(PIN_SOURCE)) {
    const props = feature.properties ?? {};
    const lngLat = (feature.geometry as Point).coordinates as LngLat;
    let seen: Seen;
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

/**
 * The pins the map's source holds, which it gathers into bubbles: all but the chosen one, which is
 * drawn once, on its own, so no bubble counts it as well.
 */
const gathered = (pins: readonly Pin[], selected: string | undefined): readonly Pin[] =>
  selected === undefined ? pins : pins.filter((pin) => pin.address !== selected);

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
  focusable,
  controls,
  onSelect,
}: {
  pin: Pin;
  accent: boolean;
  selected: boolean;
  /** In view: in the keyboard's order. A pin off the screen is not, so Tab goes only to the pins the person can see. */
  focusable: boolean;
  controls: string | undefined;
  onSelect: ((address: string, by: ChosenBy) => void) | undefined;
}): JSX.Element {
  let look: JSX.Element;
  let box: string;
  let align = "items-center";
  if (pin.look === "drop") {
    // Its marker is anchored at the bottom, and the drop stands on the foot of its 44 px box. The tip
    // is at 22 of the drawing's 24 units: moved down by the other two, a twelfth of its height, the
    // tip is on the place.
    box = "min-h-11 min-w-11 justify-center";
    align = "items-end";
    look = (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="block size-[34px] translate-y-[calc(100%/12)] wide:size-[38px]">
        <path className="fill-accent" d="M12 22s7-6.4 7-12A7 7 0 0 0 5 10c0 5.6 7 12 7 12z" />
        <circle className="fill-on-accent" cx="12" cy="10" r="2.6" />
      </svg>
    );
  } else if (pin.chainCount !== undefined) {
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
  const className = `flex ${align} border-0 bg-transparent p-0 ${box}`;
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
      aria-controls={controls}
      tabIndex={focusable ? undefined : -1}
      // A click from Enter or Space has no count of mouse clicks.
      onClick={(event) => onSelect(pin.address, event.detail === 0 ? "keyboard" : "pointer")}
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
  fit,
  interactive,
  label,
  pins = NO_PINS,
  selected,
  highlighted,
  you,
  recentre,
  onSelect,
  pinsControl,
  onMoveEnd,
  initialView,
  onViewChange,
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
  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);

  // What the map's handlers read when they run: the latest of each, not those it was made with.
  const latestProps = { center, zoom, fit, interactive, pins, selected, highlighted, onSelect, onMoveEnd, initialView, onViewChange };
  const latest = useRef(latestProps);
  useLayoutEffect(() => {
    latest.current = latestProps;
  });
  // Looks again at what the map shows: set once the map is made.
  const lookAgain = useRef<() => void>(() => {});

  // How much of the map's top and foot what floats over it covers, in pixels, and how tall the map
  // is: a pin under the search field or the docked card cannot be seen, so the keyboard skips it.
  const root = useRef<HTMLDivElement>(null);
  const topLayer = useRef<HTMLDivElement>(null);
  const bottomLayer = useRef<HTMLDivElement>(null);
  const covered = useRef({ top: 0, bottom: 0, height: 0 });
  useLayoutEffect(() => {
    // A browser that cannot watch sizes (and jsdom, which lays nothing out) counts the whole map.
    if (typeof ResizeObserver === "undefined" || root.current === null) return;
    const measure = () => {
      const box = root.current?.getBoundingClientRect();
      if (box === undefined) return;
      let top = 0;
      for (const child of topLayer.current?.children ?? []) {
        const rect = child.getBoundingClientRect();
        if (rect.height > 0) top = Math.max(top, rect.bottom - box.top);
      }
      const foot = bottomLayer.current?.getBoundingClientRect();
      const bottom = foot !== undefined && foot.height > 0 ? box.bottom - foot.top : 0;
      const last = covered.current;
      if (top === last.top && bottom === last.bottom && box.height === last.height) return;
      covered.current = { top, bottom, height: box.height };
      lookAgain.current();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root.current);
    for (const child of topLayer.current?.children ?? []) observer.observe(child);
    if (bottomLayer.current !== null) observer.observe(bottomLayer.current);
    return () => observer.disconnect();
    // After every change to the page: what floats over the map may be new (a card docked, a line said).
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

  // The data the map's source holds, so the same pins are not sent again, and the pin it is without.
  const applied = useRef<string | null>(null);
  const appliedWithout = useRef<string | undefined>(undefined);

  // Make the map, once.
  useEffect(() => {
    let cancelled = false;
    let made: MapLibreMap | undefined;
    const ownMarkers = markers.current;
    import("./maplibre.ts").then(
      (library) => {
        if (cancelled || container.current === null) return;
        const { center: here, zoom: level, fit: box, interactive: canMove, initialView: left } = latest.current;
        const start = left ?? { center: here, zoom: level };
        // Where the person left it, on Back; otherwise the box it is to show, or its centre.
        const fitted = left === undefined && box !== undefined ? { bounds: box, fitBoundsOptions: FIT_OPTIONS } : {};
        const style = mapStyle(config.mapTilerKey);
        let map: MapLibreMap;
        try {
          map = new library.Map({
            container: container.current,
            style,
            center: start.center,
            zoom: start.zoom,
            ...fitted,
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
          const items = seenOf(map);
          const bounds = map.getBounds();
          // The part of the map nothing floats over, in degrees: a city's view is close enough to flat for this.
          const { top, bottom, height } = covered.current;
          const span = bounds.getNorth() - bounds.getSouth();
          const clearNorth = height > 0 ? bounds.getNorth() - (span * top) / height : bounds.getNorth();
          const clearSouth = height > 0 ? bounds.getSouth() + (span * bottom) / height : bounds.getSouth();
          const visible = (lngLat: LngLat) => bounds.contains(lngLat) && lngLat[1] <= clearNorth && lngLat[1] >= clearSouth;
          const inView = new Set<string>();
          for (const item of items) if (visible(item.lngLat)) inView.add(item.key);
          // A source that has new data is not loaded until it has gathered it: what is read here is the
          // data last sent, which was without this pin.
          const without = appliedWithout.current;
          // The pins picked out are drawn wherever they are, inside a bubble too: whether they are in view.
          const { pins: now, selected: chosen, highlighted: pointed } = latest.current;
          for (const address of [chosen, pointed, without]) {
            const pin = address === undefined ? undefined : now.find((each) => each.address === address);
            if (pin !== undefined && visible([pin.lon, pin.lat])) inView.add(`pin:${pin.address}`);
          }
          // Drawn again only when what is drawn, or what is in view, has changed: not every frame of a move.
          setShown((current) =>
            current.without === without &&
            current.items.length === items.length &&
            current.items.every((each, i) => each.key === items[i]!.key) &&
            current.inView.size === inView.size &&
            [...inView].every((key) => current.inView.has(key))
              ? current
              : { items, inView, without },
          );
        };
        lookAgain.current = look;

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
            const now = gathered(latest.current.pins, latest.current.selected);
            appliedWithout.current = latest.current.selected;
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
          const { lng, lat: at } = map.getCenter();
          latest.current.onViewChange?.({ center: [lng, at], zoom: map.getZoom() });
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
      lookAgain.current = () => {};
      ownMarkers.clear();
    };
  }, []);

  // A pin picked out from outside the map: whether it is in view.
  useEffect(() => lookAgain.current(), [selected, highlighted]);

  // New pins, or a new chosen one: new data for the map, which gathers them again.
  const inSource = useMemo(() => gathered(pins, selected), [pins, selected]);
  const signature = useMemo(() => signatureOf(inSource), [inSource]);
  useEffect(() => {
    if (!ready || applied.current === signature) return;
    const source = mapRef.current?.getSource<GeoJSONSource>(PIN_SOURCE);
    if (source === undefined) return;
    applied.current = signature;
    appliedWithout.current = selected;
    source.setData(pinsGeoJSON(inSource));
    // `inSource` goes with `signature`, which says when they are new.
  }, [ready, signature]);

  // A new centre, or the same one asked for again: move there. The map is made at the first. While
  // the map shows a box, the box says where it looks.
  const [lon, lat] = center;
  const placed = useRef<{ lon: number; lat: number; recentre: number | undefined } | null>(null);
  useEffect(() => {
    const last = placed.current;
    placed.current = { lon, lat, recentre };
    const map = mapRef.current;
    if (last === null || map === null || latest.current.fit !== undefined) return;
    if (last.lon === lon && last.lat === lat && last.recentre === recentre) return;
    map.easeTo({ center: [lon, lat], zoom });
    // The zoom is where to land, read when the move starts; a new zoom alone is not a move.
  }, [lon, lat, recentre]);

  // A new box to show: fit the map to it. The map is made on the first; the same box again is no move.
  const fitKey = fit?.join(",");
  const fittedTo = useRef<string | undefined | null>(null);
  useEffect(() => {
    const last = fittedTo.current;
    fittedTo.current = fitKey;
    const map = mapRef.current;
    if (last === null || map === null || fitKey === last || fit === undefined) return;
    map.fitBounds(fit, FIT_OPTIONS);
    // `fit` goes with `fitKey`, which says when it is a new box.
  }, [fitKey]);

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
    for (const each of shown.items) {
      if ("cluster" in each) {
        list.push({ key: each.key, kind: "cluster", lngLat: each.lngLat, ...each.cluster });
      } else {
        const pin = byAddress.get(each.address);
        if (pin !== undefined) add(pin);
      }
    }
    // The chosen and picked-out pins wherever they are; and the pin the source was without when the map
    // was read, until the map has gathered it again: a pin let go is not missing for a frame.
    for (const address of [selected, highlighted, shown.without]) {
      const pin = address === undefined || drawn.has(address) ? undefined : byAddress.get(address);
      if (pin !== undefined) add(pin);
    }
    if (youLon !== undefined && youLat !== undefined) list.push({ key: "you", kind: "you", lngLat: [youLon, youLat] });
    return list;
  }, [shown, byAddress, selected, highlighted, youLon, youLat]);

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
        // A drop's tip is at its foot; everything else is centred on its point.
        const anchor = item.kind === "pin" && item.pin.look === "drop" ? "bottom" : "center";
        markers.current.set(item.key, new library.Marker({ element, anchor }).setLngLat(item.lngLat).addTo(map));
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
    // The bubble goes as the map opens it up. The focus goes to the map, which is named and takes the
    // keys, not to the page, where a keyboard would have to start again.
    map.getCanvas().focus({ preventScroll: true });
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
    <div ref={root} className={`relative overflow-hidden bg-map-land ${className}`}>
      {/* What floats over the map comes first, so the keyboard reaches the page's controls, the
          attribution and the docked card before the map and its pins. Each layer is placed, so the
          order on screen is the z-index's, not the page's. */}
      {failed && (
        <p className="absolute inset-0 z-10 m-0 flex items-center justify-center p-6 text-center text-secondary text-muted">
          {copy.map.failed}
        </p>
      )}
      {/* The page places what it puts here, and lets taps through where it has nothing. */}
      {children !== undefined && (
        <div ref={topLayer} className="pointer-events-none absolute inset-0 z-10">
          {children}
        </div>
      )}
      <div
        ref={bottomLayer}
        className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-col items-end gap-2 wide:inset-x-4 wide:bottom-4 wide:gap-2.5 *:pointer-events-auto">
        {corner}
        {zoomButtons && interactive && <ZoomButtons onZoom={zoomBy} />}
        <Attribution kind="map" />
        {below !== undefined && <div className="self-stretch">{below}</div>}
      </div>
      {/* MapLibre's styles make its container `position: relative`, and they win over a class here: its
          box fills one that is placed. A map that does not move is a picture: the map's own region,
          its canvas and its markers are hidden from a screen reader, which hears the picture's name. */}
      <div
        className="absolute inset-0 z-0"
        role={!interactive && label !== undefined ? "img" : undefined}
        aria-label={!interactive ? label : undefined}
      >
        <div ref={container} aria-hidden={interactive ? undefined : true} className="size-full" />
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
              tabIndex={shown.inView.has(item.key) ? undefined : -1}
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
              focusable={shown.inView.has(item.key)}
              controls={pinsControl}
              onSelect={canTap ? (tapped, by) => latest.current.onSelect?.(tapped, by) : undefined}
            />
          );
        }
        return createPortal(mark, elementFor(item.key), item.key);
      })}
    </div>
  );
}
