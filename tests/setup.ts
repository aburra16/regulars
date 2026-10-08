import "@testing-library/jest-dom/vitest";
// jsdom has no IndexedDB, and a browser does: the places are saved there.
import "fake-indexeddb/auto";

import { cleanup } from "@testing-library/react";
import { clear } from "idb-keyval";
import { afterEach, beforeEach, vi } from "vitest";

import { config } from "../src/config";
import { forgetMapPages } from "../src/explore/mapMemory";
import { forgetExploreIdx } from "../src/explore/returnPoint";
import { forgetShownInMemory } from "../src/ui/shown";
import { resetFakeMaplibre } from "./support/fakeMaplibre";

// jsdom has no WebGL, so no map can be drawn. Every test gets the stand-in in place of the map
// library: a page with a map works as it does in a browser, without tiles, and a test can play the
// map's part (tests/support/fakeMaplibre.ts).
vi.mock("maplibre-gl", () => import("./support/fakeMaplibre"));

// The house's trust relays, the relay-list relays, the scoring constants and the relays' read extras as the config module sets them.
const defaults = structuredClone({
  relayListRelays: config.relayListRelays,
  houseTrustRelays: config.houseTrustRelays,
  scoring: config.scoring,
  relayReadExtras: config.relayReadExtras,
});

// Every test starts with no map key, no review relays and no scorer override, whatever the machine's
// .env.local says, and with the default trust relays, relay-list relays, scoring and read extras, whatever a test before
// it set. A test that wants something else sets it.
beforeEach(() => {
  config.mapTilerKey = undefined;
  config.reviewRelays = [];
  config.devScorer = undefined;
  config.relayListRelays = [...defaults.relayListRelays];
  config.houseTrustRelays = [...defaults.houseTrustRelays];
  config.scoring = { ...defaults.scoring };
  config.relayReadExtras = structuredClone(defaults.relayReadExtras);
});

// Tests never open a network socket. Anything that tries fails here, loudly, instead of
// reaching a real server. Tests read places through a RelayReader (tests/support/memoryReader.ts).
class NoSocket {
  constructor() {
    throw new Error("Tests must not open a network socket. Pass a RelayReader instead.");
  }
}
globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;

// jsdom lays nothing out and scrolls nothing: it logs "not implemented" for window.scrollTo, which
// the router calls on every page change. Tests that care about scrolling spy on this.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", { configurable: true, writable: true, value: () => {} });
}

afterEach(async () => {
  cleanup();
  // Each test starts with nothing saved on the device, as on a first visit, and a page that has just been opened.
  await clear();
  forgetShownInMemory();
  forgetExploreIdx();
  forgetMapPages();
  resetFakeMaplibre();
  // A test that runs in Node, not jsdom, has no window.
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // The history of the window is the test's own: no entry index from a router that came before.
    window.history.replaceState(null, "", "/");
  }
});
