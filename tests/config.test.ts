import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { weightOf } from "../src/trust/houseWeights";

/** Loads a fresh copy of the config module under the given VITE_MAPTILER_KEY. */
async function configWithMapTilerKey(value: string | undefined) {
  vi.stubEnv("VITE_MAPTILER_KEY", value);
  vi.resetModules();
  return (await import("../src/config")).config;
}

/**
 * Loads a fresh copy of the config module under the given review relays and scorer override, in
 * development (as `npm run dev` and the tests run) or in a production build.
 */
async function configWith(env: { reviewRelays?: string; devScorer?: string; production?: boolean }) {
  vi.stubEnv("VITE_REVIEW_RELAYS", env.reviewRelays);
  vi.stubEnv("VITE_DEV_SCORER", env.devScorer);
  vi.stubEnv("DEV", !env.production);
  vi.stubEnv("PROD", env.production ?? false);
  vi.resetModules();
  return (await import("../src/config")).config;
}

// A made-up scorer: the house's real one is never written into the app or its tests.
const SCORER = "5c0e".repeat(16);

/** Brainstorm's search relay, where reviews are kept (docs/decisions.md #16). */
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

  it("opens signing in, and keeps My circle off until its scores can be worked out (M2b)", () => {
    expect(config.features).toEqual({ signIn: true, circle: false });
  });

  it("meets phone apps at one place, relay.nsec.app, only while connecting one", () => {
    expect(config.connectRelay).toBe("wss://relay.nsec.app");
  });

  it("has no map key when VITE_MAPTILER_KEY is unset", async () => {
    expect((await configWithMapTilerKey(undefined)).mapTilerKey).toBeUndefined();
  });

  it("treats an empty VITE_MAPTILER_KEY as unset, as CI passes when the secret is absent", async () => {
    expect((await configWithMapTilerKey("")).mapTilerKey).toBeUndefined();
    expect((await configWithMapTilerKey("   ")).mapTilerKey).toBeUndefined();
  });

  it("reads the map key from VITE_MAPTILER_KEY when it is set", async () => {
    expect((await configWithMapTilerKey("test-map-key")).mapTilerKey).toBe("test-map-key");
  });

  it("reads the house's trust in reviewers from Brainstorm's scores relay", () => {
    expect(config.houseTrustRelays).toEqual(["wss://scores.brainstorm.world"]);
  });

  it("looks for a person's relay list on Purplepages, and nowhere else but the review relays", () => {
    expect(config.relayListRelays).toEqual(["wss://purplepag.es"]);
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

  it("reads reviews from the search relay in a production build, whatever VITE_REVIEW_RELAYS says", async () => {
    expect((await configWith({ production: true })).reviewRelays).toEqual([SEARCH_RELAY]);
    const reviewRelays = "wss://relay.example.test";
    expect((await configWith({ reviewRelays, production: true })).reviewRelays).toEqual([SEARCH_RELAY]);
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

// These two run in order: the first changes the config, the second sees what tests/setup.ts restores.
describe("each test's config (tests/setup.ts)", () => {
  it("may be changed by a test", () => {
    config.mapTilerKey = "a-key";
    config.reviewRelays = ["ws://localhost:10547"];
    config.devScorer = { pubkey: SCORER, relay: "ws://localhost:10547" };
    config.houseTrustRelays = ["ws://localhost:10547"];
    config.scoring = { line: 50, priorWeight: 0, priorMean: 1 };
    config.relayReadExtras = { "ws://localhost:10547": { search: "spam" } };
  });

  it("is back at its defaults for the next test, with no map key, review relays or scorer override", () => {
    expect(config.mapTilerKey).toBeUndefined();
    expect(config.reviewRelays).toEqual([]);
    expect(config.devScorer).toBeUndefined();
    expect(config.houseTrustRelays).toEqual(["wss://scores.brainstorm.world"]);
    expect(config.scoring).toEqual({ line: 5, priorWeight: 1.5, priorMean: 3.5 });
    expect(config.relayReadExtras).toEqual({ [SEARCH_RELAY]: { search: "include:spam" } });
  });
});
