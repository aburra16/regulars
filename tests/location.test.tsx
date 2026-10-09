import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { NearButton } from "../src/location/CityPicker";
import { HereProvider } from "../src/location/HereProvider";
import { LocationNotice } from "../src/location/LocationNotice";
import { type Here, useHere } from "../src/location/useLocation";
import type { City } from "../src/places/indexes";
import { PlacesProvider, usePlaces } from "../src/places/store";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

// `cities` replaces the towns the indexes list. null: no indexes yet, as while the places load;
// undefined: the real ones, which need a PlacesProvider.
const override = vi.hoisted(() => ({ cities: null as City[] | null | undefined }));
vi.mock("../src/places/useIndexes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/useIndexes")>();
  return {
    useIndexes: () => {
      if (override.cities === undefined) return actual.useIndexes();
      return override.cities === null ? undefined : { cities: override.cities };
    },
  };
});

const fixtures: NostrEvent[] = raw;

const STORAGE_KEY = "regulars.here";

const lisbon: City = { name: "Lisbon", country: "PT", lat: 38.7223, lon: -9.1393, count: 120 };
const porto: City = { name: "Porto", country: "PT", lat: 41.1579, lon: -8.6291, count: 80 };
const lexingtonKY: City = { name: "Lexington", region: "KY", country: "US", lat: 38.0406, lon: -84.5037, count: 50 };
const lexingtonMA: City = { name: "Lexington", region: "MA", country: "US", lat: 42.447, lon: -71.2245, count: 9 };

afterEach(() => {
  vi.restoreAllMocks();
  override.cities = null;
  Reflect.deleteProperty(navigator, "geolocation");
  Reflect.deleteProperty(navigator, "permissions");
  Reflect.deleteProperty(navigator, "language");
});

function renderHere(opts: { strict?: boolean } = {}) {
  return renderHook(() => useHere(), {
    wrapper: ({ children }: { children: ReactNode }) => {
      const provider = <HereProvider>{children}</HereProvider>;
      return opts.strict ? <StrictMode>{provider}</StrictMode> : provider;
    },
  });
}

// ---- A browser's geolocation, for the tests ----

type Succeed = (position: GeolocationPosition) => void;
type Fail = (error: GeolocationPositionError) => void;

const position = (latitude: number, longitude: number) =>
  ({ coords: { latitude, longitude, accuracy: 20 }, timestamp: 0 }) as unknown as GeolocationPosition;
const failure = (code: number) => ({ code, message: "No." }) as GeolocationPositionError;

/** Gives the page a `navigator.geolocation`. `reads` counts how often the page looked for it. */
function installGeolocation(getCurrentPosition: (ok: Succeed, fail: Fail, options?: PositionOptions) => void) {
  const spy = vi.fn(getCurrentPosition);
  const reads = vi.fn(() => ({ getCurrentPosition: spy }));
  Object.defineProperty(navigator, "geolocation", { configurable: true, get: reads });
  return { getCurrentPosition: spy, reads };
}
const locatedAt = (latitude: number, longitude: number) =>
  installGeolocation((ok) => ok(position(latitude, longitude)));
const refusedWith = (code: number) => installGeolocation((_ok, fail) => fail(failure(code)));

const saved = () => window.localStorage.getItem(STORAGE_KEY);

// ---- The device's time zone and language, and what the browser allows, for the tests ----

// The real `resolvedOptions`, taken once, before any test stands in for it: a test that sets the
// zone twice wraps this, not its own stand-in, which would call itself until the stack ran out.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

/** The device's time zone, as `Intl` says it; everything else `Intl` says is as it is. */
function zoneIs(zone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolvedOptions.call(this), timeZone: zone };
  });
}

/** The browser's language, as `navigator.language` says it. */
function languageIs(tag: string) {
  Object.defineProperty(navigator, "language", { configurable: true, get: () => tag });
}

/** Gives the page a `navigator.permissions` whose `query` is `query`. jsdom has none. */
function installPermissions(query: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>) {
  const spy = vi.fn(query);
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: spy } });
  return spy;
}
/** The browser says this of the device's location: "granted" means it gives it without asking the person. */
const permissionIs = (state: PermissionState) => installPermissions(async () => ({ state }) as PermissionStatus);

/** Lets every answer that is already on its way arrive: the browser's word on the permission, and what follows it. */
const settle = () => act(async () => {});

describe("useHere", () => {
  it("is Funchal, the default, on a first visit when the device's zone is no place and no town is in the language's country", () => {
    // The tests' device is in UTC, which is no place, in English for the United States: no town here is in the US.
    override.cities = [lisbon, porto];
    const { result } = renderHere();
    expect(result.current).toMatchObject({
      label: config.defaultCity.name,
      lat: config.defaultCity.lat,
      lon: config.defaultCity.lon,
      source: "default",
      settling: false,
      pending: false,
    });
    expect(result.current.denied).toBeFalsy();
    expect(result.current.unavailable).toBeFalsy();
    expect(config.defaultCity.name).toBe("Funchal");
  });

  it("throws a developer error outside a HereProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useHere())).toThrow(/HereProvider/);
  });

  describe("picking a city", () => {
    it("gives the city, and keeps it across a remount", () => {
      const first = renderHere();
      act(() => first.result.current.pickCity(lisbon));
      expect(first.result.current).toMatchObject({ label: "Lisbon", lat: lisbon.lat, lon: lisbon.lon, source: "city" });
      first.unmount();

      const second = renderHere();
      expect(second.result.current).toMatchObject({ label: "Lisbon", lat: lisbon.lat, lon: lisbon.lon, source: "city" });
    });

    it("saves the city's name, region, country and coordinates under regulars.here, and no more", () => {
      const { result } = renderHere();
      act(() => result.current.pickCity(lexingtonKY));
      expect(JSON.parse(saved()!)).toEqual({
        name: "Lexington",
        region: "KY",
        country: "US",
        lat: lexingtonKY.lat,
        lon: lexingtonKY.lon,
      });

      act(() => result.current.pickCity(lisbon));
      expect(JSON.parse(saved()!)).toEqual({ name: "Lisbon", country: "PT", lat: lisbon.lat, lon: lisbon.lon });
    });

    it("works under StrictMode", () => {
      const first = renderHere({ strict: true });
      act(() => first.result.current.pickCity(porto));
      first.unmount();
      expect(renderHere({ strict: true }).result.current).toMatchObject({ label: "Porto", source: "city" });
    });

    it("labels a city as the picker does: by its name, and where it is when another town has the name", () => {
      override.cities = [lexingtonKY, lexingtonMA, lisbon];
      const first = renderHere();
      act(() => first.result.current.pickCity(lexingtonKY));
      expect(first.result.current.label).toBe("Lexington, KY");
      act(() => first.result.current.pickCity(lisbon));
      expect(first.result.current.label).toBe("Lisbon");

      // Read back from the device, where the count of its places is not kept.
      act(() => first.result.current.pickCity(lexingtonMA));
      first.unmount();
      expect(renderHere().result.current.label).toBe("Lexington, MA");
    });

    it("takes the longer label once the towns are known", () => {
      override.cities = null;
      const view = renderHere();
      act(() => view.result.current.pickCity(lexingtonKY));
      expect(view.result.current.label).toBe("Lexington");

      override.cities = [lexingtonKY, lexingtonMA];
      view.rerender();
      expect(view.result.current.label).toBe("Lexington, KY");
    });
  });

  describe("what was saved on the device", () => {
    it.each<[string, string]>([
      ["is not JSON", "{oops"],
      ["is null", "null"],
      ["is a list", "[]"],
      ["is a number", "42"],
      ["has no name", JSON.stringify({ country: "PT", lat: 1, lon: 2 })],
      ["has a blank name", JSON.stringify({ name: "  ", country: "PT", lat: 1, lon: 2 })],
      ["has no country", JSON.stringify({ name: "Lisbon", lat: 1, lon: 2 })],
      ["has a region that is not text", JSON.stringify({ name: "Lisbon", region: 5, country: "PT", lat: 1, lon: 2 })],
      ["has coordinates as text", JSON.stringify({ name: "Lisbon", country: "PT", lat: "1", lon: "2" })],
      ["has a latitude off the Earth", JSON.stringify({ name: "Lisbon", country: "PT", lat: 91, lon: 2 })],
      ["has a longitude off the Earth", JSON.stringify({ name: "Lisbon", country: "PT", lat: 1, lon: -181 })],
    ])("falls back to the default when it %s", (_what, value) => {
      window.localStorage.setItem(STORAGE_KEY, value);
      expect(renderHere().result.current).toMatchObject({ label: "Funchal", source: "default" });
    });

    it("reads a city with no region and no country text", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Atlantis", country: "", lat: 10, lon: 20 }));
      expect(renderHere().result.current).toMatchObject({ label: "Atlantis", lat: 10, lon: 20, source: "city" });
    });

    it("falls back to the default when the device refuses to be read, and still picks a city", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("Blocked.", "SecurityError");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Full.", "QuotaExceededError");
      });
      const { result } = renderHere();
      expect(result.current).toMatchObject({ label: "Funchal", source: "default" });

      act(() => result.current.pickCity(lisbon));
      expect(setItem).toHaveBeenCalled();
      expect(result.current).toMatchObject({ label: "Lisbon", source: "city" });
    });

    it("falls back to the default when the browser will not give out its storage at all", () => {
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("Blocked.", "SecurityError");
      });
      const { result } = renderHere();
      expect(result.current).toMatchObject({ label: "Funchal", source: "default" });
      act(() => result.current.pickCity(lisbon));
      expect(result.current).toMatchObject({ label: "Lisbon", source: "city" });
    });
  });

  describe("the device's location", () => {
    it("is never asked for on load, nor looked up", () => {
      const { getCurrentPosition, reads } = locatedAt(38.7, -9.1);
      const view = renderHere({ strict: true });
      view.rerender();
      expect(reads).not.toHaveBeenCalled();
      expect(getCurrentPosition).not.toHaveBeenCalled();
    });

    it("is asked for when the person asks, for a position a few minutes old, within ten seconds", () => {
      const { getCurrentPosition } = locatedAt(38.7, -9.1);
      const { result } = renderHere();
      act(() => result.current.useDevice());
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
        timeout: 10_000,
        maximumAge: 300_000,
      });
    });

    it("gives the position, as 'you', when it is granted", () => {
      locatedAt(38.7001, -9.1002);
      const { result } = renderHere();
      act(() => result.current.useDevice());
      expect(result.current).toMatchObject({ label: "you", lat: 38.7001, lon: -9.1002, source: "device" });
      expect(result.current.label).toBe(copy.location.you);
      expect(result.current.denied).toBeFalsy();
      expect(result.current.unavailable).toBeFalsy();
    });

    it("gives the position when it comes a moment later", async () => {
      installGeolocation((ok) => void setTimeout(() => ok(position(1.5, 2.5)), 5));
      const { result } = renderHere();
      act(() => result.current.useDevice());
      expect(result.current.source).toBe("default");
      await waitFor(() => expect(result.current).toMatchObject({ source: "device", lat: 1.5, lon: 2.5 }));
    });

    it("never saves the position: after a reload the default is back", () => {
      locatedAt(38.7, -9.1);
      const first = renderHere();
      act(() => first.result.current.useDevice());
      expect(first.result.current.source).toBe("device");
      expect(saved()).toBeNull();
      expect(JSON.stringify({ ...window.localStorage })).not.toContain("38.7");
      first.unmount();

      expect(renderHere().result.current).toMatchObject({ label: "Funchal", source: "default" });
    });

    it("leaves the city the person picked last saved, and goes back to it after a reload", () => {
      const first = renderHere();
      act(() => first.result.current.pickCity(porto));
      locatedAt(38.7, -9.1);
      act(() => first.result.current.useDevice());
      expect(first.result.current.source).toBe("device");
      first.unmount();

      expect(renderHere().result.current).toMatchObject({ label: "Porto", source: "city" });
    });

    describe("when the person says no", () => {
      it("keeps the default, and says so", () => {
        refusedWith(1);
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ label: "Funchal", source: "default", denied: true });
        expect(result.current.unavailable).toBeFalsy();
      });

      it("keeps the city that was picked", () => {
        refusedWith(1);
        const { result } = renderHere();
        act(() => result.current.pickCity(lisbon));
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ label: "Lisbon", lat: lisbon.lat, lon: lisbon.lon, source: "city", denied: true });
      });

      it("keeps a position it had already found", () => {
        const view = renderHere();
        locatedAt(38.7, -9.1);
        act(() => view.result.current.useDevice());
        refusedWith(1);
        act(() => view.result.current.useDevice());
        expect(view.result.current).toMatchObject({ label: "you", lat: 38.7, lon: -9.1, source: "device", denied: true });
      });

      it("does not throw or call alert", () => {
        const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
        refusedWith(1);
        const { result } = renderHere();
        expect(() => act(() => result.current.useDevice())).not.toThrow();
        expect(alert).not.toHaveBeenCalled();
      });

      it("is forgotten when the person picks a city, or finds the position", () => {
        refusedWith(1);
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current.denied).toBe(true);
        act(() => result.current.pickCity(porto));
        expect(result.current.denied).toBeFalsy();

        act(() => result.current.useDevice());
        expect(result.current.denied).toBe(true);
        locatedAt(1, 2);
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ source: "device" });
        expect(result.current.denied).toBeFalsy();
      });

      it("is not kept for the next visit", () => {
        refusedWith(1);
        const first = renderHere();
        act(() => first.result.current.useDevice());
        first.unmount();
        const second = renderHere();
        expect(second.result.current.denied).toBeFalsy();
        expect(second.result.current.unavailable).toBeFalsy();
      });
    });

    describe("when it cannot be found", () => {
      it.each([
        ["the position is unavailable", 2],
        ["it times out", 3],
        ["the error is unknown", 99],
      ])("says it is unavailable, not denied, when %s", (_why, code) => {
        refusedWith(code);
        const { result } = renderHere();
        act(() => result.current.pickCity(lisbon));
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ label: "Lisbon", source: "city", unavailable: true });
        expect(result.current.denied).toBeFalsy();
      });

      it("says so on a browser with no geolocation", () => {
        const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
        expect(navigator.geolocation).toBeUndefined();
        const { result } = renderHere();
        expect(() => act(() => result.current.useDevice())).not.toThrow();
        expect(result.current).toMatchObject({ label: "Funchal", source: "default", unavailable: true });
        expect(alert).not.toHaveBeenCalled();
      });

      it("says so when asking throws", () => {
        installGeolocation(() => {
          throw new DOMException("Not allowed here.", "SecurityError");
        });
        const { result } = renderHere();
        expect(() => act(() => result.current.useDevice())).not.toThrow();
        expect(result.current).toMatchObject({ source: "default", unavailable: true });
      });

      it("says so when the position is not a place on Earth", () => {
        installGeolocation((ok) => ok(position(Number.NaN, 12)));
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ source: "default", unavailable: true });
      });

      it("is forgotten when the person picks a city, and moves to denied if they say no next", () => {
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current.unavailable).toBe(true);
        act(() => result.current.pickCity(porto));
        expect(result.current.unavailable).toBeFalsy();

        act(() => result.current.useDevice());
        refusedWith(1);
        act(() => result.current.useDevice());
        expect(result.current.denied).toBe(true);
        expect(result.current.unavailable).toBeFalsy();
      });
    });

    it("ignores a position that arrives after the person has picked a city", () => {
      let deliver: Succeed = () => {};
      installGeolocation((ok) => {
        deliver = ok;
      });
      const { result } = renderHere();
      act(() => result.current.useDevice());
      act(() => result.current.pickCity(porto));
      act(() => deliver(position(1, 2)));
      expect(result.current).toMatchObject({ label: "Porto", source: "city" });
    });

    it("ignores a refusal that arrives after the person has picked a city", () => {
      let refuse: Fail = () => {};
      installGeolocation((_ok, fail) => {
        refuse = fail;
      });
      const { result } = renderHere();
      act(() => result.current.useDevice());
      act(() => result.current.pickCity(porto));
      act(() => refuse(failure(1)));
      expect(result.current.denied).toBeFalsy();
    });

    it("takes the last answer when the person asks twice", () => {
      const answers: Succeed[] = [];
      installGeolocation((ok) => void answers.push(ok));
      const { result } = renderHere();
      act(() => result.current.useDevice());
      act(() => result.current.useDevice());
      act(() => answers[1]!(position(3, 4)));
      act(() => answers[0]!(position(1, 2)));
      expect(result.current).toMatchObject({ source: "device", lat: 3, lon: 4 });
    });

    describe("while the device has not answered", () => {
      it("is not pending on load, nor after a pick", () => {
        const { result } = renderHere();
        expect(result.current.pending).toBe(false);
        act(() => result.current.pickCity(lisbon));
        expect(result.current.pending).toBe(false);
      });

      it("is pending from the ask until the position comes", () => {
        let deliver: Succeed = () => {};
        installGeolocation((ok) => {
          deliver = ok;
        });
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ pending: true, source: "default", label: "Funchal" });
        act(() => deliver(position(1, 2)));
        expect(result.current).toMatchObject({ pending: false, source: "device" });
      });

      it.each([
        ["the person says no", 1, "denied"],
        ["the position cannot be found", 2, "unavailable"],
      ] as const)("stops being pending when %s", (_why, code, problem) => {
        let refuse: Fail = () => {};
        installGeolocation((_ok, fail) => {
          refuse = fail;
        });
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current.pending).toBe(true);
        act(() => refuse(failure(code)));
        expect(result.current.pending).toBe(false);
        expect(result.current[problem]).toBe(true);
      });

      it("is not pending when there is no way to ask", () => {
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current).toMatchObject({ pending: false, unavailable: true });
      });

      it("stops being pending when the person picks a city instead", () => {
        installGeolocation(() => {});
        const { result } = renderHere();
        act(() => result.current.useDevice());
        act(() => result.current.pickCity(porto));
        expect(result.current).toMatchObject({ pending: false, label: "Porto" });
      });

      it("drops what the last ask said, since a new one is on its way", () => {
        refusedWith(1);
        const { result } = renderHere();
        act(() => result.current.useDevice());
        expect(result.current.denied).toBe(true);
        installGeolocation(() => {});
        act(() => result.current.useDevice());
        expect(result.current.pending).toBe(true);
        expect(result.current.denied).toBeFalsy();
      });

      it("stays pending for the latest ask when an older one answers", () => {
        const answers: Succeed[] = [];
        installGeolocation((ok) => void answers.push(ok));
        const { result } = renderHere();
        act(() => result.current.useDevice());
        act(() => result.current.useDevice());
        act(() => answers[0]!(position(1, 2)));
        expect(result.current).toMatchObject({ pending: true, source: "default" });
        act(() => answers[1]!(position(3, 4)));
        expect(result.current).toMatchObject({ pending: false, lat: 3, lon: 4 });
      });
    });

    it("does nothing when the page is gone before the position comes", () => {
      let deliver: Succeed = () => {};
      installGeolocation((ok) => {
        deliver = ok;
      });
      const view = renderHere();
      act(() => view.result.current.useDevice());
      view.unmount();
      expect(() => deliver(position(1, 2))).not.toThrow();
    });
  });
});

describe("where a first visit starts", () => {
  const newYork: City = { name: "New York", country: "US", lat: 40.7128, lon: -74.006, count: 60 };
  const chiangMai: City = { name: "Chiang Mai", country: "TH", lat: 18.7883, lon: 98.9853, count: 45 };
  const bangkok: City = { name: "Bangkok", country: "TH", lat: 13.7563, lon: 100.5018, count: 30 };

  describe("with no town picked, and the device's location not allowed", () => {
    it("is the town near the place the device's time zone is named for, though one farther away has more places", () => {
      zoneIs("Asia/Bangkok");
      override.cities = [lisbon, porto, chiangMai, bangkok];
      const { result } = renderHere();
      expect(result.current).toMatchObject({
        label: "Bangkok",
        lat: bangkok.lat,
        lon: bangkok.lon,
        source: "guess",
        settling: false,
        pending: false,
      });
    });

    it("names the town as the picker does, with where it is when another town has its name", () => {
      zoneIs("America/New_York");
      override.cities = [lisbon, lexingtonKY, lexingtonMA];
      expect(renderHere().result.current).toMatchObject({ label: "Lexington, MA", source: "guess" });
    });

    it("is the town with the most places in the language's country when the zone is no place", () => {
      zoneIs("Etc/GMT-9");
      languageIs("pt-PT");
      override.cities = [newYork, lisbon, porto];
      expect(renderHere().result.current).toMatchObject({ label: "Lisbon", lat: lisbon.lat, source: "guess" });
    });

    it.each<[string, string, City[]]>([
      ["the zone is no place and no town is in the language's country", "ja-JP", [newYork, lisbon, porto]],
      ["the zone is no place and the language names no country", "en", [newYork, lisbon, porto]],
      ["the places have no towns", "pt-PT", []],
    ])("is Funchal, the default, when %s", (_why, tag, cities) => {
      zoneIs(cities.length === 0 ? "Europe/Lisbon" : "Etc/GMT-9");
      languageIs(tag);
      override.cities = cities;
      expect(renderHere().result.current).toMatchObject({
        label: config.defaultCity.name,
        lat: config.defaultCity.lat,
        lon: config.defaultCity.lon,
        source: "default",
        settling: false,
      });
    });

    it("reads 'Near' the guessed town in the header", () => {
      zoneIs("Europe/Lisbon");
      override.cities = [newYork, lisbon, porto];
      render(
        <HereProvider>
          <NearButton />
        </HereProvider>,
      );
      expect(screen.getByRole("button", { name: "Near Lisbon" })).toBeInTheDocument();
    });

    it("gives way to a town the person picks, and that town is kept", () => {
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      const first = renderHere();
      expect(first.result.current).toMatchObject({ label: "Lisbon", source: "guess" });
      expect(saved()).toBeNull();
      act(() => first.result.current.pickCity(porto));
      first.unmount();
      expect(renderHere().result.current).toMatchObject({ label: "Porto", source: "city" });
    });
  });

  describe("a town the person picked before", () => {
    it("wins over the guess", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Porto", country: "PT", lat: porto.lat, lon: porto.lon }));
      zoneIs("Asia/Bangkok");
      override.cities = [lisbon, porto, chiangMai];
      expect(renderHere().result.current).toMatchObject({ label: "Porto", source: "city", settling: false });
    });

    it("wins over a device whose location the browser allows, which is not looked up", async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Porto", country: "PT", lat: porto.lat, lon: porto.lon }));
      const query = permissionIs("granted");
      const { reads, getCurrentPosition } = locatedAt(38.7, -9.1);
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await settle();
      expect(query).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({ label: "Porto", source: "city", pending: false });
    });

    it("is where the places are near at once, while they load", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Porto", country: "PT", lat: porto.lat, lon: porto.lon }));
      override.cities = null;
      expect(renderHere().result.current).toMatchObject({ label: "Porto", source: "city", settling: false });
    });
  });

  describe("while the places load", () => {
    it("is settling, names no town in the header, and settles on the guess when the towns come", () => {
      zoneIs("Europe/Lisbon");
      override.cities = null;
      const view = render(
        <HereProvider>
          <NearButton />
        </HereProvider>,
      );
      // The page says it is finding places; the header has no town to name yet, and offers the device.
      expect(screen.getByRole("button", { name: copy.location.useMine })).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/Funchal|Near/);

      override.cities = [lisbon, porto];
      view.rerender(
        <HereProvider>
          <NearButton />
        </HereProvider>,
      );
      expect(screen.getByRole("button", { name: "Near Lisbon" })).toBeInTheDocument();
    });

    it("is settling in what useHere gives, until the towns are known", () => {
      override.cities = null;
      const view = renderHere();
      expect(view.result.current.settling).toBe(true);
      override.cities = [lisbon];
      view.rerender();
      expect(view.result.current.settling).toBe(false);
    });

    it("never shows Funchal before the guess, with the places loading from the relay", async () => {
      override.cities = undefined;
      zoneIs("Europe/Lisbon");
      /** Three places in the middle of Lisbon, beside the fixtures in Funchal. */
      const inLisbon = fixtures.slice(0, 3).map((event, i) => ({
        ...event,
        id: `${i + 1}`.padStart(64, "a"),
        tags: [
          ...event.tags.filter(([name]) => !["d", "locality", "lat", "lon"].includes(name!)),
          ["d", `lisbon-${i}`],
          ["locality", "Lisboa"],
          ["lat", String(38.7223 + i * 0.001)],
          ["lon", "-9.1393"],
        ],
      }));
      // Every Here that reached the screen, in order.
      const shown: Here[] = [];
      function Probe() {
        const here = useHere();
        useLayoutEffect(() => {
          shown.push(here);
        });
        return null;
      }
      render(
        <PlacesProvider reader={createMemoryReader([...fixtures, ...inLisbon], { delayMs: 5 })}>
          <HereProvider>
            <NearButton />
            <Probe />
          </HereProvider>
        </PlacesProvider>,
      );
      expect(screen.getByRole("button", { name: copy.location.useMine })).toBeInTheDocument();

      // The places say Lisboa; the town is GeoNames' Lisbon.
      expect(await screen.findByRole("button", { name: "Near Lisbon" })).toBeInTheDocument();
      expect(shown[0]).toMatchObject({ settling: true });
      // Each one either waits for the places or is the guess: Funchal never shows.
      for (const here of shown) expect(here.settling || here.label === "Lisbon").toBe(true);
      expect(shown.at(-1)).toMatchObject({ label: "Lisbon", source: "guess", settling: false });
    });
  });

  describe("the device's location, when the browser already allows it", () => {
    it("is used at once, with no prompt and without the person asking", async () => {
      const query = permissionIs("granted");
      const { getCurrentPosition } = locatedAt(38.7001, -9.1002);
      zoneIs("Asia/Bangkok");
      override.cities = [lisbon, chiangMai];
      const { result } = renderHere();
      await waitFor(() => expect(result.current).toMatchObject({ label: "you", lat: 38.7001, lon: -9.1002, source: "device" }));
      expect(query).toHaveBeenCalledWith({ name: "geolocation" });
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      // With the ask on load's own, shorter, timeout.
      expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
        timeout: 5_000,
        maximumAge: 300_000,
      });
      expect(result.current).toMatchObject({ pending: false, settling: false });
      // Held in memory only, as when the person asks.
      expect(saved()).toBeNull();
    });

    it("is asked for once under StrictMode", async () => {
      permissionIs("granted");
      const { getCurrentPosition } = locatedAt(1.5, 2.5);
      override.cities = [lisbon];
      const { result } = renderHere({ strict: true });
      await waitFor(() => expect(result.current.source).toBe("device"));
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    });

    it("is used before the places load, so the guess is never needed", async () => {
      permissionIs("granted");
      locatedAt(1.5, 2.5);
      override.cities = null;
      const { result } = renderHere();
      await waitFor(() => expect(result.current).toMatchObject({ source: "device", settling: false }));
    });

    it("is pending over the guess until the device answers, with the header reading 'Finding your location…'", async () => {
      permissionIs("granted");
      let deliver: Succeed = () => {};
      const { getCurrentPosition } = installGeolocation((ok) => {
        deliver = ok;
      });
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      render(
        <HereProvider>
          <NearButton />
        </HereProvider>,
      );
      await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: copy.location.finding })).toBeInTheDocument();
      act(() => deliver(position(38.7, -9.1)));
      expect(screen.getByRole("button", { name: "Near you" })).toBeInTheDocument();
    });

    it.each([
      ["the person turned it off since", 1],
      ["the position cannot be found", 2],
      ["it times out", 3],
    ])("stays on the guess, and says nothing, when %s", async (_why, code) => {
      permissionIs("granted");
      const { getCurrentPosition } = refusedWith(code);
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      render(
        <HereProvider>
          <NearButton />
          <LocationNotice />
        </HereProvider>,
      );
      await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Near Lisbon" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("stays on the guess, and says nothing, when the browser has no geolocation", async () => {
      const query = permissionIs("granted");
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await waitFor(() => expect(query).toHaveBeenCalled());
      await settle();
      expect(result.current).toMatchObject({ label: "Lisbon", source: "guess", pending: false });
      expect(result.current.unavailable).toBeFalsy();
    });

    it("drops the position when the person picks a town before it comes", async () => {
      permissionIs("granted");
      let deliver: Succeed = () => {};
      const { getCurrentPosition } = installGeolocation((ok) => {
        deliver = ok;
      });
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
      act(() => result.current.pickCity(porto));
      act(() => deliver(position(1, 2)));
      expect(result.current).toMatchObject({ label: "Porto", source: "city", pending: false });
    });

    it("is not asked for when the person picks a town before the browser says it is allowed", async () => {
      let answer: (status: PermissionStatus) => void = () => {};
      installPermissions(() => new Promise((resolve) => (answer = resolve)));
      const { reads, getCurrentPosition } = locatedAt(1, 2);
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      act(() => result.current.pickCity(porto));
      await act(async () => answer({ state: "granted" } as PermissionStatus));
      expect(reads).not.toHaveBeenCalled();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({ label: "Porto", source: "city" });
    });

    it("does nothing when the page is gone before the browser says it is allowed", async () => {
      let answer: (status: PermissionStatus) => void = () => {};
      installPermissions(() => new Promise((resolve) => (answer = resolve)));
      const { reads } = locatedAt(1, 2);
      override.cities = [lisbon];
      const view = renderHere();
      view.unmount();
      await act(async () => answer({ state: "granted" } as PermissionStatus));
      expect(reads).not.toHaveBeenCalled();
    });
  });

  describe("the device's location, when the browser does not allow it already", () => {
    it.each<PermissionState>(["prompt", "denied"])("is not asked for when the browser says %s", async (state) => {
      const query = permissionIs(state);
      const { reads, getCurrentPosition } = locatedAt(38.7, -9.1);
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await waitFor(() => expect(query).toHaveBeenCalled());
      await settle();
      expect(reads).not.toHaveBeenCalled();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({ label: "Lisbon", source: "guess", pending: false });
    });

    it.each<[string, () => void]>([
      ["has no permissions at all", () => {}],
      [
        "will not say for the location (an older Safari)",
        () =>
          installPermissions(() => {
            throw new TypeError("Type error");
          }),
      ],
      ["fails to say", () => installPermissions(() => Promise.reject(new DOMException("No.", "InvalidStateError")))],
      ["says something it has no word for", () => installPermissions(async () => ({}) as PermissionStatus)],
    ])("is not asked for when the browser %s", async (_why, install) => {
      install();
      const { reads, getCurrentPosition } = locatedAt(38.7, -9.1);
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await settle();
      expect(reads).not.toHaveBeenCalled();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({ label: "Lisbon", source: "guess" });
    });

    it("is still one tap away: 'Use my location' asks the browser", async () => {
      permissionIs("prompt");
      const { getCurrentPosition } = locatedAt(38.7, -9.1);
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      const { result } = renderHere();
      await settle();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      act(() => result.current.useDevice());
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(result.current).toMatchObject({ label: "you", source: "device" });
    });

    it("names the guessed town when the person then says no", async () => {
      permissionIs("prompt");
      refusedWith(1);
      zoneIs("Europe/Lisbon");
      override.cities = [lisbon, porto];
      render(
        <HereProvider>
          <NearButton />
          <LocationNotice />
        </HereProvider>,
      );
      await settle();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Near Lisbon" }));
      await user.click(screen.getByRole("button", { name: copy.location.useMine }));
      expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied("Lisbon"));
    });
  });
});

describe("a device the browser already allows, while the page waits for it", () => {
  // The page holds "Finding places…" for at most 1.5 s while the device answers, so the list does
  // not show the guess and then jump to the person. The clock is the test's.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A device whose position comes when the test says. */
  function slowDevice() {
    let deliver: Succeed = () => {};
    const { getCurrentPosition } = installGeolocation((ok) => {
      deliver = ok;
    });
    return { getCurrentPosition, deliver: (lat: number, lon: number) => act(() => deliver(position(lat, lon))) };
  }

  it("is settling while the device answers, for 1.5 s at most, then the guess, and the device when it comes", async () => {
    permissionIs("granted");
    const device = slowDevice();
    zoneIs("Europe/Lisbon");
    override.cities = [lisbon, porto];
    const { result } = renderHere();
    await settle();
    expect(result.current).toMatchObject({ settling: true, pending: true });

    act(() => vi.advanceTimersByTime(1_499));
    expect(result.current.settling).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ settling: false, pending: true, label: "Lisbon", source: "guess" });

    device.deliver(38.7, -9.1);
    expect(result.current).toMatchObject({ settling: false, pending: false, label: "you", source: "device" });
  });

  it("goes straight to the device when it answers in time, and the guess never shows", async () => {
    permissionIs("granted");
    const device = slowDevice();
    zoneIs("Europe/Lisbon");
    // As in the app: the places are still loading when the browser says it allows the location.
    override.cities = null;
    const shown: Here[] = [];
    const view = renderHook(
      () => {
        const here = useHere();
        useLayoutEffect(() => {
          shown.push(here);
        });
        return here;
      },
      { wrapper: ({ children }: { children: ReactNode }) => <HereProvider>{children}</HereProvider> },
    );
    await settle();
    act(() => vi.advanceTimersByTime(300));
    override.cities = [lisbon, porto];
    view.rerender();
    act(() => vi.advanceTimersByTime(500));
    device.deliver(38.7, -9.1);
    act(() => vi.advanceTimersByTime(5_000));

    expect(shown.at(-1)).toMatchObject({ source: "device", settling: false });
    // The guess was worked out, but only ever behind the page's wait: never on screen.
    expect(shown.filter((here) => here.source === "guess" && !here.settling)).toEqual([]);
  });

  it("asks with a timeout of its own, shorter than when the person asks", async () => {
    permissionIs("granted");
    const { getCurrentPosition } = slowDevice();
    override.cities = [lisbon];
    renderHere();
    await settle();
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      timeout: 5_000,
      maximumAge: 300_000,
    });
  });

  it("stops the wait at once when the device cannot answer", async () => {
    permissionIs("granted");
    refusedWith(2);
    zoneIs("Europe/Lisbon");
    override.cities = [lisbon, porto];
    const { result } = renderHere();
    await settle();
    expect(result.current).toMatchObject({ settling: false, pending: false, label: "Lisbon", source: "guess" });
    expect(result.current.unavailable).toBeFalsy();
  });

  it("does not wait when the browser would ask the person", async () => {
    permissionIs("prompt");
    slowDevice();
    zoneIs("Europe/Lisbon");
    override.cities = [lisbon, porto];
    const { result } = renderHere();
    await settle();
    expect(result.current).toMatchObject({ settling: false, pending: false, label: "Lisbon" });
  });

  it("stops the wait when the person picks a town", async () => {
    permissionIs("granted");
    slowDevice();
    override.cities = [lisbon, porto];
    const { result } = renderHere();
    await settle();
    expect(result.current.settling).toBe(true);
    act(() => result.current.pickCity(porto));
    expect(result.current).toMatchObject({ settling: false, label: "Porto", source: "city" });
    act(() => vi.advanceTimersByTime(1_500));
    expect(result.current).toMatchObject({ settling: false, label: "Porto", source: "city" });
  });

  it("leaves no timer behind when the page goes during the wait", async () => {
    permissionIs("granted");
    slowDevice();
    override.cities = [lisbon];
    const view = renderHere();
    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the header while the places load", () => {
  it("offers only 'Use my location', which asks the browser in one tap", async () => {
    const user = userEvent.setup();
    const { getCurrentPosition } = locatedAt(38.7, -9.1);
    override.cities = null;
    render(
      <HereProvider>
        <NearButton />
      </HereProvider>,
    );
    const button = screen.getByRole("button", { name: copy.location.useMine });
    expect(button).not.toHaveAttribute("aria-haspopup");
    expect(button).toHaveClass("min-h-touch");
    await user.click(button);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Near you" })).toBeInTheDocument();
  });

  it("offers it in the search field's pill on a desktop too", async () => {
    const user = userEvent.setup();
    const { getCurrentPosition } = locatedAt(38.7, -9.1);
    override.cities = null;
    render(
      <HereProvider>
        <NearButton variant="pill" />
      </HereProvider>,
    );
    const button = screen.getByRole("button", { name: copy.location.useMine });
    expect(button).toHaveClass("min-h-touch");
    expect(within(button).getByText(copy.location.useMine)).toHaveClass("truncate");
    await user.click(button);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Near you" })).toBeInTheDocument();
  });

  it("reads 'Finding your location…' while the device has not answered", async () => {
    const user = userEvent.setup();
    installGeolocation(() => {});
    override.cities = null;
    render(
      <HereProvider>
        <NearButton />
      </HereProvider>,
    );
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(screen.getByRole("button", { name: copy.location.finding })).toBeInTheDocument();
  });

  it("names no town when the person says no before the towns are known, and the guess once they are", async () => {
    const user = userEvent.setup();
    refusedWith(1);
    zoneIs("Europe/Lisbon");
    override.cities = null;
    // A new element each time, so the rerender reads the towns again.
    const page = () => (
      <HereProvider>
        <NearButton />
        <LocationNotice />
      </HereProvider>
    );
    const view = render(page());
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(document.body).not.toHaveTextContent(/Funchal/);

    override.cities = [lisbon, porto];
    view.rerender(page());
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied("Lisbon"));
  });

  it("says at once when the position cannot be found, since that names no town", async () => {
    const user = userEvent.setup();
    override.cities = null;
    render(
      <HereProvider>
        <NearButton />
        <LocationNotice />
      </HereProvider>,
    );
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.unavailable);
  });
});

describe("the copy", () => {
  it("is the draft, word for word", () => {
    expect(copy.explore.near("Funchal")).toBe("Near Funchal");
    expect(copy.explore.near(copy.location.you)).toBe("Near you");
    expect(copy.location.denied("Funchal")).toBe(
      "Location is off, so we're showing places near Funchal. Pick a city, or turn on location in your browser settings.",
    );
    expect(copy.location.unavailable).toBe("We couldn't find your location. Pick a city instead.");
    expect(copy.location.pickTitle).toBe("Choose a place");
    expect(copy.location.useMine).toBe("Use my location");
    expect(copy.location.filterPlaceholder).toBe("Search towns and cities");
    expect(copy.location.count(7)).toBe("7 places");
    expect(copy.location.count(1)).toBe("1 place");
    expect(copy.location.count(7954)).toBe("7,954 places");
  });
});

describe("LocationNotice", () => {
  function renderNotice() {
    // Towns that are none of them in the tests' language's country: the places are near Funchal, the default.
    override.cities = [lisbon, porto];
    return renderHook(() => ({ here: useHere() }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <HereProvider>
          {children}
          <LocationNotice />
        </HereProvider>
      ),
    });
  }

  it("says nothing until something goes wrong, from a status region that is always there", () => {
    renderNotice();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("names Funchal when the person said no and the places are the default", () => {
    refusedWith(1);
    const { result } = renderNotice();
    act(() => result.current.here.useDevice());
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied("Funchal"));
  });

  it("names the city the person picked", () => {
    refusedWith(1);
    const { result } = renderNotice();
    act(() => result.current.here.pickCity(lisbon));
    act(() => result.current.here.useDevice());
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied("Lisbon"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Funchal");
  });

  it("says the places are near where the person last was, when they had been found", () => {
    const { result } = renderNotice();
    locatedAt(38.7, -9.1);
    act(() => result.current.here.useDevice());
    refusedWith(1);
    act(() => result.current.here.useDevice());
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied(copy.location.lastKnown));
  });

  it("asks for a city when the position cannot be found", () => {
    const { result } = renderNotice();
    act(() => result.current.here.useDevice());
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.unavailable);
  });

  it("goes when the person picks a city, and the region stays for the next time", () => {
    refusedWith(1);
    const { result } = renderNotice();
    const region = screen.getByRole("status");
    act(() => result.current.here.useDevice());
    expect(region).toHaveTextContent(copy.location.denied("Funchal"));
    act(() => result.current.here.pickCity(lisbon));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });

  it("passes its class to the region, so the page can place it", () => {
    render(
      <HereProvider>
        <LocationNotice className="px-gutter-desktop" />
      </HereProvider>,
    );
    expect(screen.getByRole("status")).toHaveClass("px-gutter-desktop");
  });
});

describe("NearButton", () => {
  function renderPage(opts: { cities?: City[] | null } = {}) {
    override.cities = opts.cities === undefined ? [lisbon, porto] : opts.cities;
    return render(
      <HereProvider>
        <NearButton />
        <LocationNotice />
      </HereProvider>,
    );
  }
  const nearButton = (name: string) => screen.getByRole("button", { name });

  it("reads 'Near Funchal' on a first visit, and opens the picker", async () => {
    const user = userEvent.setup();
    renderPage();
    const button = nearButton("Near Funchal");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(button);
    expect(screen.getByRole("dialog", { name: copy.location.pickTitle })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("is a button at least 44 px tall, with decorations hidden from a screen reader", () => {
    renderPage();
    const button = nearButton("Near Funchal");
    expect(button).toHaveClass("min-h-touch");
    expect(button.querySelectorAll("svg")).toHaveLength(2);
    for (const icon of button.querySelectorAll("svg")) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("moves to the city that was picked, closes the picker, and gives the focus back", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(nearButton("Near Funchal"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Lisbon/ }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(nearButton("Near Lisbon")).toHaveFocus();
    expect(JSON.parse(saved()!)).toMatchObject({ name: "Lisbon" });
  });

  it("asks for the position only when 'Use my location' is tapped, then reads 'Near you'", async () => {
    const user = userEvent.setup();
    const { getCurrentPosition, reads } = locatedAt(38.7, -9.1);
    renderPage();
    await user.click(nearButton("Near Funchal"));
    expect(reads).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(nearButton("Near you")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("keeps Funchal, shows why, and still has a working picker when the person says no", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    refusedWith(1);
    renderPage();
    await user.click(nearButton("Near Funchal"));
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));

    expect(nearButton("Near Funchal")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.denied("Funchal"));
    expect(alert).not.toHaveBeenCalled();

    // The picker opens again, and a city can still be picked.
    await user.click(nearButton("Near Funchal"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Porto/ }));
    expect(nearButton("Near Porto")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("asks for a city when there is no way to find the position", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(nearButton("Near Funchal"));
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(nearButton("Near Funchal")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.location.unavailable);
  });

  it("reads 'Finding your location…' while the device has not answered", async () => {
    const user = userEvent.setup();
    let deliver: Succeed = () => {};
    installGeolocation((ok) => {
      deliver = ok;
    });
    renderPage();
    await user.click(nearButton("Near Funchal"));
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(nearButton(copy.location.finding)).toBeInTheDocument();
    act(() => deliver(position(38.7, -9.1)));
    expect(nearButton("Near you")).toBeInTheDocument();
  });

  // Safari does not focus a button that is clicked, so the picker cannot hand the focus back to it.
  describe("gives the focus back to itself, though a click did not focus it", () => {
    function openWithoutFocus() {
      renderPage();
      const button = nearButton("Near Funchal");
      fireEvent.click(button);
      expect(button).not.toHaveFocus();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      return button;
    }

    it("when the picker closes on Escape", async () => {
      const user = userEvent.setup();
      const button = openWithoutFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(button).toHaveFocus();
    });

    it("when the picker closes from its close button", () => {
      const button = openWithoutFocus();
      fireEvent.click(screen.getByRole("button", { name: copy.location.close }));
      expect(button).toHaveFocus();
    });

    it("when a city is picked", () => {
      openWithoutFocus();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Porto/ }));
      expect(nearButton("Near Porto")).toHaveFocus();
    });

    it("when 'Use my location' is tapped", () => {
      locatedAt(38.7, -9.1);
      openWithoutFocus();
      fireEvent.click(screen.getByRole("button", { name: copy.location.useMine }));
      expect(nearButton("Near you")).toHaveFocus();
    });
  });

  it("comes as a pill inside a search field on a desktop, opening the same picker", async () => {
    const user = userEvent.setup();
    override.cities = [lisbon];
    render(
      <HereProvider>
        <NearButton variant="pill" />
      </HereProvider>,
    );
    const button = nearButton("Near Funchal");
    expect(button).toHaveClass("min-h-touch");
    // A pin, and no chevron.
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    await user.click(button);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Lisbon/ }));
    expect(nearButton("Near Lisbon")).toHaveFocus();
  });

  it("lists the towns of the places that load, with the real indexes", async () => {
    override.cities = undefined;
    const user = userEvent.setup();
    function Loaded() {
      const { savedAt } = usePlaces();
      return savedAt === undefined ? null : <p>saved</p>;
    }
    render(
      <PlacesProvider reader={createMemoryReader(fixtures)}>
        <HereProvider>
          <NearButton />
          <Loaded />
        </HereProvider>
      </PlacesProvider>,
    );
    // The places are saved on the device a moment after they show.
    await screen.findByText("saved");

    await user.click(nearButton("Near Funchal"));
    const row = within(screen.getByRole("dialog")).getByRole("button", { name: /^Funchal/ });
    // Funchal is GeoNames' town: 42 of the 43 places are nearest it, those whose locality is a parish
    // of it or that have none among them. The other is in São Roque, a town nearer it.
    expect(row).toHaveTextContent(copy.location.count(42));
  });
});
