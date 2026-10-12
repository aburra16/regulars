import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { FOLLOW_PREVIEW_KEY, previewsFollow } from "../src/preview";

/*
 * The preview switch (ruling R39; src/preview.ts): Follow ships off, and a production build has it
 * only in a browser that was once opened at an address with `?preview=follow`. These hold the switch
 * to what it keeps on the device, to what it takes out of the address and what it leaves, and to
 * being read before the config's flag is, so that the page the switch came with has Follow already.
 * tests/setup.ts lets go of what a test kept on the device, and puts the address back.
 */

/** The page's address, from its path on. */
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

/** The page is opened at `to`, an address in the app, with `state` as its history's. */
const openedAt = (to: string, state: unknown = null) => window.history.replaceState(state, "", to);

/** Loads a fresh copy of the config module, as a production build has it or as development and the tests do. */
async function configIn(build: "production" | "development") {
  vi.stubEnv("DEV", build === "development");
  vi.stubEnv("PROD", build === "production");
  vi.resetModules();
  return (await import("../src/config")).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Follow, behind the preview switch (ruling R39)", () => {
  it("is on in development and in the tests, whatever the browser keeps", async () => {
    expect(config.features.follow).toBe(true);
    expect((await configIn("development")).features.follow).toBe(true);
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "off");
    expect((await configIn("development")).features.follow).toBe(true);
  });

  it("is off in a production build, in a browser that keeps nothing of it", async () => {
    expect((await configIn("production")).features.follow).toBe(false);
  });

  it("is on in a production build only where the browser keeps the switch on: the key, and exactly `on`", async () => {
    expect(FOLLOW_PREVIEW_KEY).toBe("regulars.preview.follow");
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    expect((await configIn("production")).features.follow).toBe(true);

    for (const other of ["off", "ON", "true", "1", " on", ""]) {
      window.localStorage.setItem(FOLLOW_PREVIEW_KEY, other);
      expect((await configIn("production")).features.follow, JSON.stringify(other)).toBe(false);
    }
    // Kept for the session only is not kept: the switch is the device's.
    window.localStorage.clear();
    window.sessionStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    expect((await configIn("production")).features.follow).toBe(false);
  });

  it("is on from the page the switch came with: the address is read before the flag is", async () => {
    openedAt("/person/npub1example?preview=follow");

    const production = await configIn("production");

    expect(production.features.follow).toBe(true);
    expect(window.localStorage.getItem(FOLLOW_PREVIEW_KEY)).toBe("on");
    expect(address()).toBe("/person/npub1example");
  });

  it("is off from the page that turned it off", async () => {
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    openedAt("/?preview=follow-off");

    const production = await configIn("production");

    expect(production.features.follow).toBe(false);
    expect(window.localStorage.getItem(FOLLOW_PREVIEW_KEY)).toBeNull();
    expect(address()).toBe("/");
  });
});

describe("the switch in the address", () => {
  it("keeps Follow on for this browser, and takes itself out of the address", () => {
    openedAt("/?preview=follow");

    expect(previewsFollow()).toBe(true);

    expect(window.localStorage.getItem(FOLLOW_PREVIEW_KEY)).toBe("on");
    expect(address()).toBe("/");
    // And it stays on for the next page, which has no switch in its address.
    expect(previewsFollow()).toBe(true);
    expect(address()).toBe("/");
  });

  it.each([
    ["first", "/place/osm-node-1?preview=follow&sort=newest&q=bolo%20de+caco#reviews", "/place/osm-node-1?sort=newest&q=bolo%20de+caco#reviews"],
    ["last", "/place/osm-node-1?sort=newest&q=bolo%20de+caco&preview=follow#reviews", "/place/osm-node-1?sort=newest&q=bolo%20de+caco#reviews"],
    ["in the middle", "/search?q=a%26b&preview=follow&flag&x=#top", "/search?q=a%26b&flag&x=#top"],
    ["alone, before a section", "/about?preview=follow#data", "/about#data"],
    ["beside another preview", "/?preview=saved&preview=follow", "/?preview=saved"],
  ])("takes out its own parameter and nothing else, %s: the path, every other parameter as it was written, and the section stay", (_, opened, left) => {
    openedAt(opened);

    expect(previewsFollow()).toBe(true);

    expect(address()).toBe(left);
  });

  it("keeps what the history held for the page", () => {
    const state = { idx: 3, key: "abc" };
    openedAt("/?preview=follow", state);

    previewsFollow();

    expect(window.history.state).toEqual(state);
    expect(address()).toBe("/");
  });

  it("replaces the page's entry in the history, and adds none", () => {
    openedAt("/?preview=follow");
    const entries = window.history.length;

    previewsFollow();

    expect(window.history.length).toBe(entries);
  });

  it("lets go of it with follow-off, and takes that out of the address the same way", () => {
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    openedAt("/explore?near=funchal&preview=follow-off#list");

    expect(previewsFollow()).toBe(false);

    expect(window.localStorage.getItem(FOLLOW_PREVIEW_KEY)).toBeNull();
    expect(address()).toBe("/explore?near=funchal#list");
    // Off where it was never on, too.
    openedAt("/?preview=follow-off");
    expect(previewsFollow()).toBe(false);
    expect(address()).toBe("/");
  });

  it.each([
    ["another value", "/?preview=saved"],
    ["a value that only begins like it", "/?preview=follow-on"],
    ["a value that only ends like it", "/?preview=unfollow"],
    ["no value", "/?preview"],
    ["an empty value", "/?preview="],
    ["another case", "/?preview=Follow"],
    ["another parameter of that value", "/?previews=follow&view=follow"],
    ["the words in the path", "/preview=follow"],
    ["the words in the section", "/#preview=follow"],
  ])("does nothing for %s, and leaves the address alone", (_, opened) => {
    openedAt(opened);

    expect(previewsFollow()).toBe(false);

    expect(window.localStorage.getItem(FOLLOW_PREVIEW_KEY)).toBeNull();
    expect(address()).toBe(opened);
    // Nor does it turn off what was on.
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    expect(previewsFollow()).toBe(true);
    expect(address()).toBe(opened);
  });
});

describe("a browser that keeps nothing", () => {
  it("has Follow off, and nothing throws, when what it keeps cannot be read", async () => {
    window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    expect(previewsFollow()).toBe(false);
    expect((await configIn("production")).features.follow).toBe(false);
  });

  it("has Follow off, and nothing throws, when it will not keep the switch: the parameter goes all the same", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    openedAt("/place/osm-node-1?preview=follow&sort=newest");

    expect(previewsFollow()).toBe(false);

    expect(address()).toBe("/place/osm-node-1?sort=newest");
    openedAt("/?preview=follow");
    expect((await configIn("production")).features.follow).toBe(false);
    expect(address()).toBe("/");
  });

  it("has Follow off, and nothing throws, when it has no storage to ask: asking for it throws", async () => {
    const blocked = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      openedAt("/?preview=follow&sort=newest");

      expect(previewsFollow()).toBe(false);
      expect(address()).toBe("/?sort=newest");
      expect((await configIn("production")).features.follow).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", blocked);
    }
  });
});
