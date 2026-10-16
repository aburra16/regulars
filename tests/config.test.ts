import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { weightOf } from "../src/trust/houseWeights";

/** What is open as config.ts sets it, read as this file loads: before tests/setup.ts sets anything for a test. */
const SET_FEATURES = structuredClone(config.features);

/**
 * Loads a fresh copy of the config module under the given review relays, follow-list relays and
 * scorer override, in development (as `npm run dev` and the tests run) or in a production build.
 */
async function configWith(env: { reviewRelays?: string; followListRelays?: string; devScorer?: string; production?: boolean }) {
  vi.stubEnv("VITE_REVIEW_RELAYS", env.reviewRelays);
  vi.stubEnv("VITE_FOLLOW_LIST_RELAYS", env.followListRelays);
  vi.stubEnv("VITE_DEV_SCORER", env.devScorer);
  vi.stubEnv("DEV", !env.production);
  vi.stubEnv("PROD", env.production ?? false);
  vi.resetModules();
  return (await import("../src/config")).config;
}

// A made-up scorer: the house's real one is never written into the app or its tests.
const SCORER = "5c0e".repeat(16);

/** Brainstorm's search relay, where reviews are kept (decision 16). */
const SEARCH_RELAY = "wss://search.brainstorm.world";

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("derives the house public key from the house account at module load", () => {
    expect(config.houseNpub).toBe("npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8");
    expect(config.houseHex).toBe("4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64");
  });

  it("points at the Food and Drink Places header", () => {
    expect(config.headerCoordinate).toMatch(/^39998:[0-9a-f]{64}:food-and-drink-places$/);
    expect(config.headerCoordinate).toBe(
      "39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places",
    );
  });

  it("names the app, the domain, the places relay and the default city", () => {
    expect(config.appName).toBe("Regulars");
    expect(config.domain).toBe("askregulars.world");
    expect(config.placesRelay).toBe("wss://dcosl.brainstorm.world");
    expect(config.defaultCity).toEqual({ name: "Funchal", lat: 32.6507, lon: -16.9084, radiusKm: 25 });
  });

  it("opens signing in, and My circle now that its scores can be worked out (M2b; M3 Task 3), keeps Saved off until saved lists exist, and has Follow on (ruling R39)", () => {
    // As config.ts sets them: tests/setup.ts closes My circle before each test, whatever it says, and
    // the tests of My circle open it.
    expect(SET_FEATURES).toEqual({ signIn: true, circle: true, saved: false, follow: true });
  });

  it("has Follow on for everyone, in a production build as in development", async () => {
    expect((await configWith({ production: true })).features.follow).toBe(true);
    expect((await configWith({})).features.follow).toBe(true);
  });

  it("meets phone apps at one place, relay.nsec.app, only while connecting one", () => {
    expect(config.connectRelay).toBe("wss://relay.nsec.app");
  });

  it("links to Brainstorm's own site from the foot of every page, in a production build as in development", async () => {
    expect(config.brainstormSite).toBe("https://brainstorm.world");
    expect((await configWith({ production: true })).brainstormSite).toBe("https://brainstorm.world");
    // The site a person opens is not the API the app asks.
    expect(config.brainstormSite).not.toBe(config.brainstormApi);
  });

  it("draws every map with tiles, in development and in a production build, with no key", async () => {
    for (const production of [false, true]) {
      const fresh = await configWith({ production });
      expect(fresh.mapTiles).toBe(true);
      expect(fresh).not.toHaveProperty("mapTilerKey");
    }
  });

  it("asks for no map key in the builds or the example settings", () => {
    for (const file of [".github/workflows/deploy.yml", ".github/workflows/android-release.yml", ".env.example"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/MAPTILER/i);
    }
  });

  it("reads the house's trust in reviewers from Brainstorm's scores relay", () => {
    expect(config.houseTrustRelays).toEqual(["wss://scores.brainstorm.world"]);
  });

  it("looks for a person's relay list on Purplepages, and nowhere else but the review relays", () => {
    expect(config.relayListRelays).toEqual(["wss://purplepag.es"]);
  });

  it("reads and saves a follow list at Purplepages and five public relays in a production build, whatever VITE_FOLLOW_LIST_RELAYS says: six, so that enough can answer with one or two down", async () => {
    const production = [
      "wss://purplepag.es",
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://relay.damus.io",
      "wss://nostr.mom",
      "wss://nostr.oxtr.dev",
    ];
    expect((await configWith({ production: true })).followListRelays).toEqual(production);
    expect((await configWith({ followListRelays: "wss://relay.example.test", production: true })).followListRelays).toEqual(production);
  });

  it("reads and saves follow lists nowhere of its own in development when VITE_FOLLOW_LIST_RELAYS is unset or blank: no public relay is written to (ruling R17)", async () => {
    expect((await configWith({})).followListRelays).toEqual([]);
    expect((await configWith({ followListRelays: " " })).followListRelays).toEqual([]);
    // The review relays' setting is its own: it names no relay for follow lists.
    expect((await configWith({ reviewRelays: "ws://localhost:10547" })).followListRelays).toEqual([]);
  });

  it("reads and saves follow lists at the ws and wss relays in VITE_FOLLOW_LIST_RELAYS, in development", async () => {
    const followListRelays = " ws://localhost:10547 , https://relay.example.test,wss://relay.example.test,,nonsense";
    expect((await configWith({ followListRelays })).followListRelays).toEqual(["ws://localhost:10547", "wss://relay.example.test"]);
  });

  it("counts a reviewer from rank 5 (decision 18), and orders lists with 1.5 votes of 3.5 stars", () => {
    expect(config.scoring).toEqual({ line: 5, priorWeight: 1.5, priorMean: 3.5 });
  });

  it("gives a reviewer ranked 4 no weight at the house line, and one ranked 5 a weight of 0.05", () => {
    expect(weightOf(4, config.scoring.line)).toBe(0);
    expect(weightOf(5, config.scoring.line)).toBe(0.05);
  });

  it("asks the search relay for reviews flagged as spam too, and asks no other relay that", async () => {
    const extras = { [SEARCH_RELAY]: { search: "include:spam" } };
    expect(config.relayReadExtras).toEqual(extras);
    expect((await configWith({ production: true })).relayReadExtras).toEqual(extras);
  });

  it("reads no reviews when VITE_REVIEW_RELAYS is unset or blank", async () => {
    expect((await configWith({})).reviewRelays).toEqual([]);
    expect((await configWith({ reviewRelays: " " })).reviewRelays).toEqual([]);
  });

  it("reads reviews from the ws and wss relays in VITE_REVIEW_RELAYS, in development", async () => {
    const reviewRelays = " ws://localhost:10547 , https://relay.example.test,wss://relay.example.test,,nonsense";
    expect((await configWith({ reviewRelays })).reviewRelays).toEqual([
      "ws://localhost:10547",
      "wss://relay.example.test",
    ]);
  });

  it("posts and reads reviews at the search relay and two public relays in a production build, never the list hub, whatever VITE_REVIEW_RELAYS says", async () => {
    const production = [SEARCH_RELAY, "wss://nos.lol", "wss://relay.primal.net"];
    const built = await configWith({ production: true });
    expect(built.reviewRelays).toEqual(production);
    // The list hub is where the places are read from. It stores only the list kinds, so it holds no
    // reviews.
    expect(built.reviewRelays).not.toContain(built.placesRelay);
    const reviewRelays = "wss://relay.example.test";
    expect((await configWith({ reviewRelays, production: true })).reviewRelays).toEqual(production);
  });

  it("takes a scorer from VITE_DEV_SCORER in development", async () => {
    expect((await configWith({})).devScorer).toBeUndefined();
    expect((await configWith({ devScorer: `${SCORER}@ws://localhost:10547` })).devScorer).toEqual({
      pubkey: SCORER,
      relay: "ws://localhost:10547",
    });
  });

  it("takes no scorer from a VITE_DEV_SCORER that is not <hex key>@<ws or wss relay>", async () => {
    for (const devScorer of [
      " ",
      SCORER,
      `${SCORER}@`,
      `@ws://localhost:10547`,
      `${SCORER.slice(1)}@ws://localhost:10547`,
      `${SCORER.toUpperCase()}@ws://localhost:10547`,
      `${SCORER}@https://localhost:10547`,
    ]) {
      expect((await configWith({ devScorer })).devScorer, devScorer).toBeUndefined();
    }
  });

  it("takes no scorer from VITE_DEV_SCORER in a production build", async () => {
    const devScorer = `${SCORER}@wss://relay.example.test`;
    expect((await configWith({ devScorer, production: true })).devScorer).toBeUndefined();
  });
});

/**
 * Fails unless the config is as tests/setup.ts puts it before each test: My circle and Saved closed,
 * Follow on, no map tiles, no review relays, follow-list relays or scorer override, and the trust relays,
 * relay-list relays, scoring and read extras as config.ts sets them.
 */
function expectEachTestsConfig(): void {
  expect(config.features).toMatchObject({ circle: false, saved: false, follow: true });
  expect(config.mapTiles).toBe(false);
  expect(config.reviewRelays).toEqual([]);
  expect(config.devScorer).toBeUndefined();
  expect(config.houseTrustRelays).toEqual(["wss://scores.brainstorm.world"]);
  expect(config.relayListRelays).toEqual(["wss://purplepag.es"]);
  expect(config.followListRelays).toEqual([]);
  expect(config.scoring).toEqual({ line: 5, priorWeight: 1.5, priorMean: 3.5 });
  expect(config.relayReadExtras).toEqual({ [SEARCH_RELAY]: { search: "include:spam" } });
}

/** Changes every part of the config that tests/setup.ts puts back, in place and by replacing it. */
function changeEverything(): void {
  config.features.circle = true;
  config.features.saved = true;
  config.features.follow = false;
  config.mapTiles = true;
  config.reviewRelays = ["ws://localhost:10547"];
  config.devScorer = { pubkey: SCORER, relay: "ws://localhost:10547" };
  config.houseTrustRelays.push("ws://localhost:10547");
  config.relayListRelays = ["ws://localhost:10547"];
  config.followListRelays = ["ws://localhost:10547"];
  config.scoring.line = 50;
  config.relayReadExtras[SEARCH_RELAY]!.search = "spam";
}

// Each of these starts by checking the config is as each test's is, then changes all of it: whichever
// order they run in, the second sees that what the first changed did not reach it. Neither needs the
// other to run first, and either alone still checks the config it starts with.
describe("each test's config (tests/setup.ts)", () => {
  it.each(["one", "another"])("is at its defaults as %s test starts, whatever a test before it changed", () => {
    expectEachTestsConfig();
    changeEverything();
    expect(config.scoring.line).toBe(50);
  });
});
