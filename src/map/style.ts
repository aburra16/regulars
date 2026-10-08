import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

/** MapTiler's Dataviz Light: a quiet map in greys, which the tokens' land, park and water colours are laid over. */
export const MAPTILER_STYLE_URL = "https://api.maptiler.com/maps/dataviz-light/style.json";

/** The map colours of the tokens, with their values in tokens.css for a page that has not loaded the styles. */
const TOKEN_COLOURS = {
  "--map-land": "#E4EAEE",
  "--map-park": "#CFE3DA",
  "--map-water": "#CBDDEA",
} as const;

type MapToken = keyof typeof TOKEN_COLOURS;

/** A map colour as the page has it: the token's value, or its value in tokens.css. */
function tokenColour(token: MapToken): string {
  const value =
    typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value === "" ? TOKEN_COLOURS[token] : value;
}

/**
 * The style of every map. With a MapTiler key, MapTiler's Dataviz Light, which `recolour` then
 * gives the tokens' colours. Without one (an empty or blank key is none), a ground in the land
 * colour and nothing else: no tiles, no fonts, nothing fetched from anywhere. The pins still go on it.
 */
export function mapStyle(key: string | undefined): StyleSpecification | string {
  const trimmed = key?.trim();
  if (trimmed) return `${MAPTILER_STYLE_URL}?key=${encodeURIComponent(trimmed)}`;
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": tokenColour("--map-land") } }],
  };
}

/**
 * Which of MapTiler's layers take which token, by the layer's id in Dataviz Light: the ground and
 * where people live are land, green spaces are park, and the sea and rivers are water.
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
 * Gives MapTiler's land, parks and water the tokens' colours, once its style has loaded, at once
 * rather than with the style's fade. Each layer is coloured by its own type ("River" is a line). A layer the style does not have is skipped:
 * MapTiler can rename one at any time, and the map must still draw.
 */
export function recolour(map: Pick<MapLibreMap, "getLayer" | "setPaintProperty">): void {
  for (const [id, token] of RECOLOURS) {
    const type = map.getLayer(id)?.type;
    if (type === undefined || !isColoured(type)) continue;
    const [property, transition] = COLOUR_PROPERTY[type];
    try {
      map.setPaintProperty(id, transition, AT_ONCE);
      map.setPaintProperty(id, property, tokenColour(token));
    } catch {
      // A layer whose colour cannot be set keeps MapTiler's. The map is still a map.
    }
  }
}
