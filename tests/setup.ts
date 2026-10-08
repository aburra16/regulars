import "@testing-library/jest-dom/vitest";
// jsdom has no IndexedDB, and a browser does: the places are saved there.
import "fake-indexeddb/auto";

import { cleanup } from "@testing-library/react";
import { clear } from "idb-keyval";
import { afterEach } from "vitest";

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
  // Each test starts with nothing saved on the device, as on a first visit.
  await clear();
  // A test that runs in Node, not jsdom, has no window.
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});
