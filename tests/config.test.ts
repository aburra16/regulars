import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";

/** Loads a fresh copy of the config module under the given VITE_MAPTILER_KEY. */
async function configWithMapTilerKey(value: string | undefined) {
  vi.stubEnv("VITE_MAPTILER_KEY", value);
  vi.resetModules();
  return (await import("../src/config")).config;
}

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

  it("keeps sign-in switched off in M1", () => {
    expect(config.features.signIn).toBe(false);
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
});
