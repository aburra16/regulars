/*
 * The map library, with its styles and the worker it draws tiles in. BaseMap loads this module
 * when a map is first drawn, so MapLibre (about 1 MB) is a chunk of its own that the pages without
 * a map never fetch.
 */
import "maplibre-gl/dist/maplibre-gl.css";

import { setWorkerUrl } from "maplibre-gl";
// The worker, built by Vite as a file of its own. MapLibre would otherwise look for it next to its
// own file in node_modules, which a bundled app does not have.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

export { Map, Marker } from "maplibre-gl";
