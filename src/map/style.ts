import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import { currentTheme, type Theme } from "../theme/theme.ts";

/** MapTiler's Dataviz Light: a quiet map in greys, which the tokens' land, park and water colours are laid over. */
export const MAPTILER_STYLE_URL = "https://api.maptiler.com/maps/dataviz-light/style.json";

/** Its dark twin, from the same host with the same key, for the dark theme: its labels and roads are light on dark. */
export const MAPTILER_DARK_STYLE_URL = "https://api.maptiler.com/maps/dataviz-dark/style.json";

const STYLE_URLS: Readonly<Record<Theme, string>> = { light: MAPTILER_STYLE_URL, dark: MAPTILER_DARK_STYLE_URL };

/**
 * The map colours of the tokens in each theme, with their values in src/styles/index.css for a page
 * that has not loaded the styles (tests/theme.test.tsx checks the two agree).
 */
const TOKEN_COLOURS = {
  light: { "--map-land": "#E4EAEE", "--map-park": "#CFE3DA", "--map-water": "#CBDDEA" },
  dark: { "--map-land": "#1B2430", "--map-park": "#1D352F", "--map-water": "#0C1724" },
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
 * The style of every map, in the page's theme unless told another. With a MapTiler key, MapTiler's
 * Dataviz Light, or Dataviz Dark in the dark theme, which `recolour` then gives the tokens' colours.
 * Without one (an empty or blank key is none), a ground in the land colour and nothing else: no tiles,
 * no fonts, nothing fetched from anywhere. The pins still go on it.
 */
export function mapStyle(key: string | undefined, theme: Theme = currentTheme()): StyleSpecification | string {
  const trimmed = key?.trim();
  if (trimmed) return `${STYLE_URLS[theme]}?key=${encodeURIComponent(trimmed)}`;
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": tokenColour("--map-land", theme) } }],
  };
}

/**
 * Which of MapTiler's layers take which token, by the layer's id in Dataviz Light and Dataviz Dark,
 * which name their layers alike: the ground and where people live are land, green spaces are park,
 * and the sea and rivers are water.
 */
const RECOLOURS: ReadonlyArray<readonly [layer: string, token: MapToken]> = [
  ["Background", "--map-land"],
  ["Residential", "--map-land"],
  ["Landcover", "--map-park"],
  ["Forest", "--map-park"],
  ["Stadium", "--map-park"],
  ["Cemetery", "--map-park"],
  ["Water shadow", "--map-water"],
  ["Water", "--map-water"],
  ["River", "--map-water"],
];

/** The paint property that colours a layer of each type, and the one that says how a new colour fades in. Other types are not coloured. */
const COLOUR_PROPERTY = {
  background: ["background-color", "background-color-transition"],
  fill: ["fill-color", "fill-color-transition"],
  line: ["line-color", "line-color-transition"],
} as const;

const isColoured = (type: string): type is keyof typeof COLOUR_PROPERTY => type in COLOUR_PROPERTY;

/** No fade: the style's own transition would draw MapTiler's greys first and fade them to the tokens'. */
const AT_ONCE = { duration: 0, delay: 0 };

/**
 * Gives MapTiler's land, parks and water the tokens' colours in `theme` (the page's, unless told
 * another), once its style has loaded, at once rather than with the style's fade. Each layer is
 * coloured by its own type ("River" is a line). A layer the style does not have is skipped: MapTiler
 * can rename one at any time, and the map must still draw.
 */
export function recolour(map: Pick<MapLibreMap, "getLayer" | "setPaintProperty">, theme: Theme = currentTheme()): void {
  for (const [id, token] of RECOLOURS) {
    const type = map.getLayer(id)?.type;
    if (type === undefined || !isColoured(type)) continue;
    const [property, transition] = COLOUR_PROPERTY[type];
    try {
      map.setPaintProperty(id, transition, AT_ONCE);
      map.setPaintProperty(id, property, tokenColour(token, theme));
    } catch {
      // A layer whose colour cannot be set keeps MapTiler's. The map is still a map.
    }
  }
}
