// An entry point for tests/opening-hours-chunk.test.ts: it uses the hours module from a single
// module, so the build has something to split out even before a screen uses it. The build drops
// the exports of an entry that nothing imports, so they are put somewhere the build must keep.
import { openLine, openState } from "../../src/places/hours.ts";

Object.assign(globalThis, { openLine, openState });
