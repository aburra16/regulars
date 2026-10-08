// An entry point for tests/maplibre-chunk.test.ts: it uses the map from a single module, as a
// page does. The build drops the exports of an entry that nothing imports, so they are put
// somewhere the build must keep.
import { BaseMap } from "../../src/map/BaseMap.tsx";

Object.assign(globalThis, { BaseMap });
