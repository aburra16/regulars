import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import { currentTheme, type Theme } from "../theme/theme.ts";

/**
 * OpenFreeMap's public servers, which need no key: the map's styles, and the tiles, fonts and sprite
 * the styles name, all come from this one host. Another tile server changes this, and the host the
 * policy lets the page reach (`connect-src` in tools/csp.ts).
 */
export const TILES_BASE = "https://tiles.openfreemap.org";

/** OpenFreeMap's Positron: a quiet map in greys, which the tokens' land, park and water colours are laid over. */
export const LIGHT_STYLE_URL = `${TILES_BASE}/styles/positron`;

/** OpenFreeMap's Dark, from the same host, for the dark theme: its roads, buildings and labels are drawn for a dark ground. */
export const DARK_STYLE_URL = `${TILES_BASE}/styles/dark`;

const STYLE_URLS: Readonly<Record<Theme, string>> = { light: LIGHT_STYLE_URL, dark: DARK_STYLE_URL };

/**
 * The map colours of the tokens in each theme, with their values in src/styles/index.css for a page
 * that has not loaded the styles (tests/theme.test.tsx checks the two agree).
 */
const TOKEN_COLOURS = {
  light: {
    "--map-land": "#E4EAEE",
    "--map-park": "#CFE3DA",
    "--map-water": "#CBDDEA",
    "--map-road": "#FFFFFF",
    "--map-building": "#EAEAE5",
    "--map-label": "#666666",
  },
  dark: {
    "--map-land": "#1B2430",
    "--map-park": "#1D352F",
    "--map-water": "#0C1724",
    "--map-road": "#3D4B5E",
    "--map-building": "#232E3C",
    "--map-label": "#9AA5B2",
  },
} as const;

type MapToken = keyof (typeof TOKEN_COLOURS)["light"];

/**
 * A map colour in `theme`: the token's value as the page has it when the page is in that theme (it
 * is, for a map drawn in the page's theme), or else its value in the stylesheet.
 */
function tokenColour(token: MapToken, theme: Theme): string {
  const value =
    typeof document === "undefined" || theme !== currentTheme()
      ? ""
      : getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value === "" ? TOKEN_COLOURS[theme][token] : value;
}

/**
 * The style of every map, in the page's theme unless told another. With `tiles`, OpenFreeMap's
 * Positron, or Dark in the dark theme, which `recolour` then gives the tokens' colours. Without, a
 * ground in the land colour and nothing else: no tiles, no fonts, nothing fetched from anywhere. That
 * is the map when a style does not come, and in the tests. The pins still go on it.
 */
export function mapStyle(tiles: boolean, theme: Theme = currentTheme()): StyleSpecification | string {
  if (tiles) return STYLE_URLS[theme];
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": tokenColour("--map-land", theme) } }],
  };
}

/**
 * Which of the styles' layers take which token, by the layer's id in Positron and Dark: the ground and
 * where people live are land, green spaces and woods are park, and the sea and rivers are water. The
 * two name their parks apart (Positron's `park`, Dark's `landuse_park`), so each skips the other's.
 */
const BY_ID: ReadonlyMap<string, MapToken> = new Map([
  ["background", "--map-land"],
  ["landuse_residential", "--map-land"],
  ["park", "--map-park"],
  ["landuse_park", "--map-park"],
  ["landcover_wood", "--map-park"],
  ["water", "--map-water"],
  ["waterway", "--map-water"],
]);

/**
 * The token every other layer that takes one is coloured with, by what it draws: its type, and the
 * layer of the tiles it draws (its `source-layer`), whatever the layer is called, so a layer the
 * style renames or adds is still caught. Every road, path and railway line, and every road's area
 * (a pier, a square), is road; every building's fill is building; every label is label.
 */
function byWhatItDraws(type: string, sourceLayer: string | undefined): MapToken | undefined {
  if ((type === "line" || type === "fill") && sourceLayer === "transportation") return "--map-road";
  if (type === "fill" && sourceLayer === "building") return "--map-building";
  if (type === "symbol") return "--map-label";
  return undefined;
}

/** The paint property that colours a layer of each type (a label's words), and the one that says how a new colour fades in. Other types are not coloured. */
const COLOUR_PROPERTY = {
  background: ["background-color", "background-color-transition"],
  fill: ["fill-color", "fill-color-transition"],
  line: ["line-color", "line-color-transition"],
  symbol: ["text-color", "text-color-transition"],
} as const;

const isColoured = (type: string): type is keyof typeof COLOUR_PROPERTY => type in COLOUR_PROPERTY;

/** No fade: the style's own transition would draw its own colours first and fade them to the tokens'. */
const AT_ONCE = { duration: 0, delay: 0 };

/**
 * What a line's dashes (its `line-dasharray`) are. `gapless`: dashes with no gaps between them, as the
 * styles draw the casings of major roads (`[12, 0]`), a whole line whose dashes' ends could show as
 * beads in one colour with the road. `gapped`: dashes with gaps, the footpath's convention, as Dark
 * draws its footpaths, sidewalks and pedestrian streets (`[1.5, 1.5]`). `none`: no dashes, or dashes in
 * an expression, which are left as they are.
 */
function dashesOf(value: unknown): "gapless" | "gapped" | "none" {
  if (!Array.isArray(value) || value.length === 0 || !value.every((length) => typeof length === "number")) return "none";
  return value.some((length, i) => i % 2 === 1 && length !== 0) ? "gapped" : "gapless";
}

/** How opaque a dashed footpath is drawn: enough to see, and quieter than the roads it runs beside. */
const FOOTPATH_OPACITY = 0.45;

/**
 * Gives the style the tokens' colours in `theme` (the page's, unless told another), once it has
 * loaded, at once rather than with the style's fade: its land, parks and water by their layers' ids,
 * and its roads, buildings and labels by what they draw. Each layer is coloured by its own type
 * (`waterway` is a line, a label's colour is its words'). A label's halo is the land colour.
 * A fill is drawn in its colour alone, without a pattern, which would be drawn in place of the colour
 * (Dark's woods have one). Parks, water, roads and buildings are fully opaque (Dark draws its woods
 * at 40%). A fill in the land colour is not drawn at all: it would only paint the ground the
 * background paints already, and where people live is drawn after the parks and the water, over them.
 * A road drawn in dashes with no gaps is drawn whole; one drawn in dashes with gaps is a footpath,
 * and keeps its dashes, drawn quieter than the roads it runs beside (in Dark, the sidewalks beside a
 * road would otherwise read as beads on its edges). A layer the style does not have is skipped:
 * OpenFreeMap can rename one at any time, and the map must still draw.
 */
export function recolour(
  map: Pick<MapLibreMap, "getLayer" | "getLayersOrder" | "getPaintProperty" | "setPaintProperty">,
  theme: Theme = currentTheme(),
): void {
  for (const id of map.getLayersOrder()) {
    const layer = map.getLayer(id);
    if (layer === undefined || !isColoured(layer.type)) continue;
    const token = BY_ID.get(id) ?? byWhatItDraws(layer.type, layer.sourceLayer);
    if (token === undefined) continue;
    const [property, transition] = COLOUR_PROPERTY[layer.type];
    try {
      map.setPaintProperty(id, transition, AT_ONCE);
      map.setPaintProperty(id, property, tokenColour(token, theme));
      if (layer.type === "symbol") {
        map.setPaintProperty(id, "text-halo-color-transition", AT_ONCE);
        map.setPaintProperty(id, "text-halo-color", tokenColour("--map-land", theme));
      }
      if (layer.type === "line" && token === "--map-road") {
        const dashes = dashesOf(map.getPaintProperty(id, "line-dasharray"));
        if (dashes === "gapless") {
          map.setPaintProperty(id, "line-dasharray-transition", AT_ONCE);
          map.setPaintProperty(id, "line-dasharray", undefined);
        } else if (dashes === "gapped") {
          map.setPaintProperty(id, "line-opacity-transition", AT_ONCE);
          map.setPaintProperty(id, "line-opacity", FOOTPATH_OPACITY);
        }
      }
      if (layer.type === "fill") {
        map.setPaintProperty(id, "fill-opacity-transition", AT_ONCE);
        map.setPaintProperty(id, "fill-opacity", token === "--map-land" ? 0 : 1);
        map.setPaintProperty(id, "fill-pattern-transition", AT_ONCE);
        map.setPaintProperty(id, "fill-pattern", undefined);
      }
    } catch {
      // A layer whose colour cannot be set keeps the style's own. The map is still a map.
    }
  }
}
