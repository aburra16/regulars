import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, type RouteObject, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import type { RelayReader } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import { PlacesProvider, type PlacesValue } from "../src/places/store";
import { routes } from "../src/routes";
import { useDocumentTitle } from "../src/shell/useDocumentTitle";
import { useWide, WIDE_QUERY } from "../src/shell/useWide";
import { Attribution } from "../src/ui/Attribution";
import { HouseName } from "../src/ui/HouseName";
import { KindTile } from "../src/ui/KindTile";
import { Stars } from "../src/ui/Stars";
import { ViewToggle } from "../src/ui/ViewToggle";
import { useView, VIEW_STORAGE_KEY, ViewProvider } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

// `value` replaces what usePlaces gives; undefined: the real store, which needs a PlacesProvider.
const placesOverride = vi.hoisted(() => ({ value: undefined as PlacesValue | undefined }));
vi.mock("../src/places/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/store")>();
  return { ...actual, usePlaces: () => placesOverride.value ?? actual.usePlaces() };
});

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);

const PHONE = 390;
const DESKTOP = 1360;

// ---- A browser window of a given width, for matchMedia ----

let width = PHONE;
const widthListeners = new Set<() => void>();

/** Gives the page a `window.matchMedia` that answers `(min-width: Npx)` for the current width. */
function setWidth(px: number) {
  width = px;
  window.matchMedia = (query: string) => {
    const min = Number(/\(min-width:\s*(\d+)px\)/.exec(query)?.[1] ?? Number.NaN);
    const listeners = new Set<() => void>();
    return {
      media: query,
      get matches() {
        return width >= min;
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
        widthListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
        widthListeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
}

/** The window is resized: every query that listens hears it. */
function resizeTo(px: number) {
  act(() => {
    width = px;
    for (const listener of [...widthListeners]) listener();
  });
}

// ---- The places, as usePlaces gives them ----

function placesState(over: Partial<PlacesValue> = {}): PlacesValue {
  return { status: "ready", places: fixturePlaces, source: "network", complete: true, retry: vi.fn(), ...over };
}

let online = true;
function setOnline(value: boolean) {
  act(() => {
    online = value;
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

beforeEach(() => {
  setWidth(PHONE);
  placesOverride.value = placesState();
  online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
});

afterEach(() => {
  vi.restoreAllMocks();
  widthListeners.clear();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(navigator, "onLine");
  config.features.circle = false;
});

/** The whole app at `path`, as main.tsx puts it together, with a router that keeps its history in memory. */
function renderApp(path = "/", opts: { width?: number } = {}) {
  setWidth(opts.width ?? PHONE);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <HereProvider>
      <RouterProvider router={router} />
    </HereProvider>,
  );
  return { router, ...view };
}

const tabBar = () => screen.queryByRole("navigation", { name: copy.nav.label });
const topBarSearch = () => screen.queryByRole("search");
const toggle = () => screen.getByRole("group", { name: copy.view.label });

/**
 * The shell's two quiet regions, in the order of the page: where the places are near (under the
 * top of the page), then how the places loaded. Both are always there, empty until they have
 * something to say. The pages draw their own status lines inside `main`, which these leave out.
 */
const shellRegions = () => screen.getAllByRole("status").filter((region) => region.closest("main") === null);
const locationRegion = () => {
  const [region, ...rest] = shellRegions();
  expect(rest).toHaveLength(1);
  return region!;
};
const loadRegion = () => shellRegions().at(-1)!;

describe("useWide", () => {
  const wideAt = (px: number) => {
    setWidth(px);
    return renderHook(() => useWide()).result;
  };

  it("asks for the one breakpoint, 900 px", () => {
    expect(WIDE_QUERY).toBe("(min-width: 900px)");
  });

  it("is false on a phone and true on a desktop, from 900 px up", () => {
    expect(wideAt(PHONE).current).toBe(false);
    expect(wideAt(899).current).toBe(false);
    expect(wideAt(900).current).toBe(true);
    expect(wideAt(DESKTOP).current).toBe(true);
  });

  it("follows the window as it is resized", () => {
    const result = wideAt(PHONE);
    resizeTo(DESKTOP);
    expect(result.current).toBe(true);
    resizeTo(PHONE);
    expect(result.current).toBe(false);
  });

  it("is the phone layout in a browser with no matchMedia", () => {
    Reflect.deleteProperty(window, "matchMedia");
    expect(renderHook(() => useWide()).result.current).toBe(false);
  });
});

describe("the layout, by width", () => {
  it("at 390 px shows the tabs Explore, Map, Saved and You, and no top bar", () => {
    renderApp("/", { width: PHONE });
    const tabs = within(tabBar()!).getAllByRole("link");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Explore", "Map", "Saved", "You"]);
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual(["/", "/map", "/saved", "/you"]);
    expect(within(tabBar()!).getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
    for (const tab of tabs) expect(tab.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    expect(topBarSearch()).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("at 390 px puts the wordmark, the account and 'Near Funchal' at the top of Explore", () => {
    renderApp("/", { width: PHONE });
    const top = screen.getByRole("banner");
    expect(within(top).getByText(copy.app.name)).toBeInTheDocument();
    expect(within(top).getByRole("link", { name: copy.nav.account })).toHaveAttribute("href", "/you");
    expect(within(top).getByRole("button", { name: "Near Funchal" })).toBeInTheDocument();
  });

  it("at 390 px shows the tabs on Map, Saved and You, marking the page that is open", () => {
    for (const [path, tab] of [
      ["/map", "Map"],
      ["/saved", "Saved"],
      ["/you", "You"],
    ] as const) {
      const { unmount } = renderApp(path, { width: PHONE });
      expect(within(tabBar()!).getByRole("link", { name: tab })).toHaveAttribute("aria-current", "page");
      // Only Explore has the "Near" control at its top.
      expect(screen.queryByRole("button", { name: "Near Funchal" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("at 390 px leaves the tabs off the pages that open from a list", () => {
    for (const path of ["/search?q=tea", "/filters", "/place/osm-node-1", "/chain/abc", "/about", "/signin"]) {
      const { unmount } = renderApp(path, { width: PHONE });
      expect(tabBar()).not.toBeInTheDocument();
      unmount();
    }
  });

  it("at 1360 px shows the top bar: wordmark, search with its location, the toggle, Saved and the account", () => {
    renderApp("/", { width: DESKTOP });
    const bar = screen.getByRole("banner");

    expect(within(bar).getByRole("link", { name: copy.app.name })).toHaveAttribute("href", "/");
    const search = within(bar).getByRole("search");
    expect(within(search).getByRole("searchbox", { name: copy.search.label })).toHaveAttribute(
      "placeholder",
      copy.search.placeholder,
    );
    expect(within(search).getByRole("button", { name: "Near Funchal" })).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(bar).getByRole("group", { name: copy.view.label })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: copy.view.house })).toHaveAttribute("aria-pressed", "true");
    expect(within(bar).getByRole("link", { name: copy.nav.saved })).toHaveAttribute("href", "/saved");
    expect(within(bar).getByRole("link", { name: copy.nav.account })).toHaveAttribute("href", "/you");

    expect(tabBar()).not.toBeInTheDocument();
  });

  it("at 1360 px shows the one top bar on every page but sign in, and never the tabs", () => {
    for (const path of ["/map", "/search?q=tea", "/place/osm-node-1", "/chain/abc", "/about", "/saved", "/you"]) {
      const { unmount } = renderApp(path, { width: DESKTOP });
      expect(topBarSearch()).toBeInTheDocument();
      expect(toggle()).toBeInTheDocument();
      expect(tabBar()).not.toBeInTheDocument();
      unmount();
    }
    renderApp("/signin", { width: DESKTOP });
    expect(topBarSearch()).not.toBeInTheDocument();
  });

  it("marks Saved in the top bar when it is open", () => {
    renderApp("/saved", { width: DESKTOP });
    expect(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.saved })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("switches between the two as the window is resized", () => {
    renderApp("/", { width: PHONE });
    expect(tabBar()).toBeInTheDocument();
    resizeTo(DESKTOP);
    expect(tabBar()).not.toBeInTheDocument();
    expect(topBarSearch()).toBeInTheDocument();
    resizeTo(PHONE);
    expect(tabBar()).toBeInTheDocument();
    expect(topBarSearch()).not.toBeInTheDocument();
  });

  it("opens the city picker from the location in the search field", async () => {
    const user = userEvent.setup();
    renderApp("/", { width: DESKTOP });
    await user.click(within(screen.getByRole("search")).getByRole("button", { name: "Near Funchal" }));
    const dialog = screen.getByRole("dialog", { name: copy.location.pickTitle });
    await user.click(within(dialog).getByRole("button", { name: /^Funchal/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(screen.getByRole("search")).getByRole("button", { name: "Near Funchal" })).toHaveFocus();
  });

  it("says why the places are not near the person, in a region that is always there", async () => {
    const user = userEvent.setup();
    renderApp("/", { width: DESKTOP });
    const region = locationRegion();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();

    // No geolocation in this browser: the picker's "Use my location" cannot find the person.
    await user.click(screen.getByRole("button", { name: "Near Funchal" }));
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(locationRegion()).toBe(region);
    expect(region).toHaveTextContent(copy.location.unavailable);
  });
});

describe("the search field in the top bar", () => {
  it("searches for what is typed", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/", { width: DESKTOP });
    await user.type(screen.getByRole("searchbox", { name: copy.search.label }), "  pizza {Enter}");
    expect(router.state.location.pathname).toBe("/search");
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("pizza");
  });

  it("does nothing when there is nothing to search for", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/", { width: DESKTOP });
    await user.type(screen.getByRole("searchbox", { name: copy.search.label }), "   {Enter}");
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows the search on the search page, and keeps its filters for the next one", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/search?q=pizza&open=1&sort=name", { width: DESKTOP });
    const field = screen.getByRole("searchbox", { name: copy.search.label });
    expect(field).toHaveValue("pizza");

    await user.clear(field);
    await user.type(field, "tea{Enter}");
    const params = new URLSearchParams(router.state.location.search);
    expect(Object.fromEntries(params)).toEqual({ q: "tea", open: "1", sort: "name" });
  });

  it("empties once the person leaves the search page", async () => {
    const { router } = renderApp("/search?q=pizza", { width: DESKTOP });
    await act(() => router.navigate("/place/osm-node-1"));
    expect(screen.getByRole("searchbox", { name: copy.search.label })).toHaveValue("");
  });
});

describe("ViewToggle", () => {
  function renderToggle(props: Partial<Parameters<typeof ViewToggle>[0]> = {}) {
    const onChange = vi.fn();
    render(<ViewToggle value="house" onChange={onChange} {...props} />);
    return onChange;
  }

  it("is a group of two buttons, House picks and My circle, with the chosen one pressed", () => {
    renderToggle({ value: "house" });
    const buttons = within(toggle()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["House picks", "My circle"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    for (const button of buttons) expect(button).toHaveAttribute("type", "button");
  });

  it("presses My circle when that is the view", () => {
    renderToggle({ value: "circle" });
    expect(screen.getByRole("button", { name: "My circle" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "House picks" })).toHaveAttribute("aria-pressed", "false");
  });

  it("tells its parent which view was tapped, and nothing when it is the view already", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ value: "house" });
    await user.click(screen.getByRole("button", { name: "My circle" }));
    expect(onChange).toHaveBeenCalledWith("circle");
    await user.click(screen.getByRole("button", { name: "House picks" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows both scores when it has them, as on the place page", () => {
    renderToggle({ value: "circle", scores: { house: 4.5, circle: 4.8 } });
    expect(screen.getByRole("button", { name: "House picks · 4.5" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "My circle · 4.8" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a score with one decimal, and only the scores it has", () => {
    renderToggle({ scores: { house: 4 } });
    expect(screen.getByRole("button", { name: "House picks · 4.0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My circle" })).toBeInTheDocument();
  });

  it("makes each button at least 44 px tall to tap", () => {
    for (const variant of ["bar", "compact", "panel"] as const) {
      const { unmount } = render(<ViewToggle value="house" onChange={() => {}} variant={variant} />);
      for (const button of within(toggle()).getAllByRole("button")) {
        // 44 px tall, or 40 px drawn with a 44 px area to tap (the desktop top bar).
        expect(button.className).toMatch(/\bh-11\b|\bafter:-inset-y-0\.5\b/);
      }
      unmount();
    }
  });
});

describe("the toggle while My circle is not open", () => {
  it("goes to the sign-in page when My circle is tapped by someone not signed in, and the view stays House picks", async () => {
    const user = userEvent.setup();
    expect(config.features.circle).toBe(false);
    // A page of its own on a desktop (the desktop's /map is Explore).
    const { router } = renderApp("/about", { width: DESKTOP });

    await user.click(within(toggle()).getByRole("button", { name: "My circle" }));
    expect(router.state.location.pathname).toBe("/signin");
    expect((router.state.location.state as { from: { pathname: string } }).from.pathname).toBe("/about");
    expect(window.sessionStorage.getItem(VIEW_STORAGE_KEY)).not.toBe("circle");

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/about");
    expect(within(toggle()).getByRole("button", { name: "House picks" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toggle()).getByRole("button", { name: "My circle" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switches to My circle once My circle is open", async () => {
    const user = userEvent.setup();
    config.features.circle = true;
    const { router } = renderApp("/", { width: DESKTOP });
    await user.click(within(toggle()).getByRole("button", { name: "My circle" }));
    expect(router.state.location.pathname).toBe("/");
    expect(within(toggle()).getByRole("button", { name: "My circle" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ViewProvider", () => {
  const renderView = () => renderHook(() => useView(), { wrapper: ({ children }) => <ViewProvider>{children}</ViewProvider> });

  it("starts on House picks", () => {
    expect(renderView().result.current.view).toBe("house");
  });

  it("keeps the view for the session, under regulars.view", () => {
    config.features.circle = true;
    const first = renderView();
    act(() => first.result.current.setView("circle"));
    expect(first.result.current.view).toBe("circle");
    expect(window.sessionStorage.getItem("regulars.view")).toBe("circle");
    first.unmount();
    expect(renderView().result.current.view).toBe("circle");
    // The session's storage, not the device's.
    expect(window.localStorage.getItem("regulars.view")).toBeNull();
  });

  it("is House picks while My circle is not open, whatever the session says", () => {
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, "circle");
    expect(renderView().result.current.view).toBe("house");
  });

  it("is House picks when the session holds something else", () => {
    config.features.circle = true;
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, "everyone");
    expect(renderView().result.current.view).toBe("house");
  });

  it("works when the browser will not give out its session storage", () => {
    config.features.circle = true;
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked.", "SecurityError");
    });
    const { result } = renderView();
    expect(result.current.view).toBe("house");
    act(() => result.current.setView("circle"));
    expect(result.current.view).toBe("circle");
  });

  it("throws a developer error outside a ViewProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useView())).toThrow(/ViewProvider/);
  });
});

describe("Attribution", () => {
  it("reads '© MapTiler © OpenStreetMap contributors' on a map, with each name linking to its terms", () => {
    const { container } = render(<Attribution kind="map" />);
    expect(container).toHaveTextContent(/^© MapTiler © OpenStreetMap contributors$/);
    expect(copy.attribution.map).toBe("© MapTiler © OpenStreetMap contributors");

    const mapTiler = screen.getByRole("link", { name: "MapTiler" });
    const osm = screen.getByRole("link", { name: "OpenStreetMap contributors" });
    expect(mapTiler).toHaveAttribute("href", "https://www.maptiler.com/copyright/");
    expect(osm).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    for (const link of [mapTiler, osm]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("reads 'Place details © OpenStreetMap contributors, via BTC Map' under place details", () => {
    const { container } = render(<Attribution kind="details" />);
    expect(container).toHaveTextContent(/^Place details © OpenStreetMap contributors, via BTC Map$/);
    expect(copy.attribution.details).toBe("Place details © OpenStreetMap contributors, via BTC Map");

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("OpenStreetMap contributors");
    expect(links[0]).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("the load banners", () => {
  const exploreHeading = () => screen.queryByRole("heading", { name: copy.pages.explore });

  it("says the places shown are the saved ones when the relay could not be reached", () => {
    placesOverride.value = placesState({ source: "cache", error: "network", savedAt: 1 });
    renderApp("/");
    expect(screen.getByText(copy.load.cached)).toBeInTheDocument();
    expect(copy.load.cached).toBe("Showing places saved on this device");
    expect(loadRegion()).toHaveAttribute("role", "status");
    expect(loadRegion()).toHaveTextContent(copy.load.cached);
    // The page itself still shows.
    expect(exploreHeading()).toBeInTheDocument();
  });

  it("says nothing when the places are fresh, or saved and not yet refreshed", () => {
    placesOverride.value = placesState({ source: "network" });
    const first = renderApp("/");
    expect(loadRegion()).toBeEmptyDOMElement();
    first.unmount();

    placesOverride.value = placesState({ source: "cache", savedAt: 1 });
    renderApp("/");
    expect(loadRegion()).toBeEmptyDOMElement();
  });

  it("says nothing when the list may be short, to keep the page calm", () => {
    placesOverride.value = placesState({ complete: false });
    renderApp("/", { width: DESKTOP });
    expect(loadRegion()).toBeEmptyDOMElement();
  });

  it("fills the page with the error and a Try again button when no places could be loaded", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    placesOverride.value = placesState({ status: "error", places: [], error: "network", retry });
    renderApp("/");

    expect(screen.getByRole("alert")).toHaveTextContent(copy.load.failed);
    expect(copy.load.failed).toBe("We couldn't load places. Check your connection and try again.");
    expect(exploreHeading()).not.toBeInTheDocument();
    // The tabs stay, so the person can still move about.
    expect(tabBar()).toBeInTheDocument();

    const button = screen.getByRole("button", { name: copy.load.retry });
    expect(button).toHaveTextContent("Try again");
    await user.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("fills the page with a calm loading line while the first places load", () => {
    placesOverride.value = placesState({ status: "loading", places: [], source: "network", complete: false });
    renderApp("/");
    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    expect(exploreHeading()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets the pages that need no places open while the places fail or load", () => {
    for (const status of ["error", "loading"] as const) {
      placesOverride.value = placesState({ status, places: [], complete: false });
      for (const [path, title] of [
        ["/signin", copy.signin.headline],
        ["/saved", copy.pages.saved],
        ["/you", copy.pages.you],
      ] as const) {
        const { unmount } = renderApp(path);
        expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
        expect(screen.queryByText(copy.load.failed)).not.toBeInTheDocument();
        expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument();
        unmount();
      }
    }
  });

  it("says the person is offline, and that the places are the saved ones, until they are back", () => {
    placesOverride.value = placesState({ source: "cache", error: "network", savedAt: 1 });
    renderApp("/", { width: DESKTOP });
    setOnline(false);
    const status = loadRegion();
    // One line, not two.
    expect(status.textContent).toBe(copy.offline);

    setOnline(true);
    expect(status.textContent).toBe(copy.load.cached);
  });

  it("says the places are the saved ones only when they are", () => {
    online = false;
    placesOverride.value = placesState({ source: "cache", savedAt: 1 });
    renderApp("/");
    expect(loadRegion().textContent).toBe(copy.offline);
  });

  it("says only that the person is offline when the places did not come from the device", () => {
    online = false;
    placesOverride.value = placesState({ source: "network" });
    renderApp("/");
    expect(loadRegion().textContent).toBe(copy.offlineNoCache);
    expect(copy.offlineNoCache).toBe("You're offline.");
    expect(loadRegion()).not.toHaveTextContent(/saved on this device/);

    // Back on line, there is nothing to say.
    setOnline(true);
    expect(loadRegion()).toBeEmptyDOMElement();
  });

  it.each(["loading", "error"] as const)(
    "says at once that the device is offline when there are no places at all (%s), not that they are on their way",
    (status) => {
      online = false;
      placesOverride.value = placesState({ status, places: [], source: "network", complete: false });
      renderApp("/");
      const message = screen.getByText(copy.load.offline);
      expect(copy.load.offline).toBe("You're offline. Places will load when you're back online.");
      expect(message).toHaveAttribute("role", "status");
      expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.load.failed)).not.toBeInTheDocument();
      // One line about it, not two.
      expect(loadRegion()).toBeEmptyDOMElement();
      expect(exploreHeading()).not.toBeInTheDocument();

      // Back on line, the page goes back to the places' own state.
      setOnline(true);
      expect(screen.queryByText(copy.load.offline)).not.toBeInTheDocument();
      expect(screen.getByText(status === "loading" ? copy.load.loading : copy.load.failed)).toBeInTheDocument();
    },
  );

  it("recovers with the real store: an error, then Try again, then the places (Review Focus 1)", async () => {
    placesOverride.value = undefined;
    const user = userEvent.setup();
    // The relay cannot be reached the first time, and answers the second.
    const working = createMemoryReader(fixtures);
    let failed = 0;
    const flaky: RelayReader = {
      req(filter, signal) {
        if (failed === 0) {
          failed += 1;
          return (async function* () {
            yield* [];
            throw new Error("unreachable");
          })();
        }
        return working.req(filter, signal);
      },
    };
    setWidth(PHONE);
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(
      <PlacesProvider reader={flaky}>
        <HereProvider>
          <RouterProvider router={router} />
        </HereProvider>
      </PlacesProvider>,
    );

    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: copy.load.retry }));
    expect(await screen.findByRole("heading", { name: copy.pages.explore })).toBeInTheDocument();
    expect(screen.queryByText(copy.load.failed)).not.toBeInTheDocument();
    expect(failed).toBe(1);
    expect(working.requests.length).toBeGreaterThan(0);
  });
});

describe("the routes", () => {
  it.each([
    ["/", copy.pages.explore],
    ["/map", copy.pages.map],
    ["/search?q=pizza&open=1&kinds=cafes&within=5&sort=name", copy.pages.search],
    ["/filters", copy.pages.filters],
    ["/place/osm-node-11330857543", "Jacafé"],
    ["/place/osm-node-123", copy.place.noLongerListed],
    // No chain has this key: the page says so.
    ["/chain/copper-kettle-pt", copy.place.noLongerListed],
    ["/about", copy.about.title],
    ["/signin", copy.signin.headline],
    ["/saved", copy.pages.saved],
    ["/you", copy.pages.you],
  ])("%s shows its page", (path, title) => {
    renderApp(path);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  });

  it("passes the place, the chain and the search through to the page", () => {
    const place = renderApp("/place/osm-node-123");
    expect(place.router.state.matches.at(-1)?.params).toEqual({ d: "osm-node-123" });
    place.unmount();

    const chain = renderApp("/chain/copper-kettle-pt");
    expect(chain.router.state.matches.at(-1)?.params).toEqual({ key: "copper-kettle-pt" });
    chain.unmount();

    const search = renderApp("/search?q=pizza&open=1&kinds=cafes&within=5&sort=name");
    expect(search.router.state.location.search).toBe("?q=pizza&open=1&kinds=cafes&within=5&sort=name");
  });

  it("says an unknown address has nothing, with a way back to Explore, and no status code", () => {
    renderApp("/no/such/page");
    expect(screen.getByText(copy.missing.text)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.missing.home })).toHaveAttribute("href", "/");
    expect(document.body).not.toHaveTextContent(/404/);
  });

  it("says a page that broke went wrong, in a diner's words, inside the app", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): ReactNode {
      throw new Error("TypeError: cannot read properties of undefined");
    }
    // The app's own routes, with a page that throws added beside the others.
    const [shell] = routes;
    const [pages] = shell!.children!;
    const broken = [
      { ...shell, children: [{ ...pages, children: [{ path: "broken", element: <Broken /> }, ...pages!.children!] }] },
    ] as RouteObject[];
    setWidth(PHONE);
    const router = createMemoryRouter(broken, { initialEntries: ["/broken"] });
    render(
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>,
    );
    expect(screen.getByText(copy.broken.text)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.broken.home })).toHaveAttribute("href", "/");
    expect(document.body).not.toHaveTextContent(/TypeError|undefined/);
  });
});

describe("Stars", () => {
  const fills = () => Array.from(screen.getByRole("img").querySelectorAll("[data-fill]")).map((star) => star.getAttribute("data-fill"));

  it("draws five stars with halves, named for a screen reader", () => {
    render(<Stars value={4.5} />);
    expect(screen.getByRole("img", { name: "4.5 out of 5" })).toBeInTheDocument();
    expect(copy.score.starsLabel(4.5)).toBe("4.5 out of 5");
    expect(fills()).toEqual(["full", "full", "full", "full", "half"]);
  });

  it.each<[number, string[], string]>([
    [0, ["empty", "empty", "empty", "empty", "empty"], "0 out of 5"],
    [5, ["full", "full", "full", "full", "full"], "5 out of 5"],
    [4.8, ["full", "full", "full", "full", "full"], "4.8 out of 5"],
    [3.2, ["full", "full", "full", "empty", "empty"], "3.2 out of 5"],
    [2.3, ["full", "full", "half", "empty", "empty"], "2.3 out of 5"],
    [0.5, ["half", "empty", "empty", "empty", "empty"], "0.5 out of 5"],
    [7, ["full", "full", "full", "full", "full"], "5 out of 5"],
    [-1, ["empty", "empty", "empty", "empty", "empty"], "0 out of 5"],
    [Number.NaN, ["empty", "empty", "empty", "empty", "empty"], "0 out of 5"],
  ])("draws %s to the nearest half star", (value, expected, label) => {
    render(<Stars value={value} />);
    expect(fills()).toEqual(expected);
    expect(screen.getByRole("img")).toHaveAccessibleName(label);
  });

  it("draws 16 px stars from the star icon, filled in accent and empty in the strong line colour", () => {
    render(<Stars value={2.5} />);
    const stars = screen.getByRole("img").querySelectorAll("[data-fill]");
    for (const star of stars) {
      expect(star).toHaveClass("size-4", "text-line-strong");
      expect(star.querySelector("svg path")).toHaveAttribute("d", expect.stringMatching(/^M8 1l2\.2 4\.4/));
    }
    const half = stars[2]!.querySelector(".text-accent");
    expect(half).toHaveClass("w-1/2");
    expect(stars[0]!.querySelector(".text-accent")).toHaveClass("w-full");
    expect(stars[4]!.querySelector(".text-accent")).toBeNull();
  });
});

describe("KindTile", () => {
  const svgOf = (container: HTMLElement) => container.querySelector("svg");

  it("puts the family's icon in the page, drawn in the tile's text colour", () => {
    const { container } = render(<KindTile category="restaurant" size="card" />);
    const svg = svgOf(container);
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg!.querySelector("path")).toHaveAttribute("d", expect.stringMatching(/^M6 3v6a2 2 0 0 0 4 0V3/));
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toHaveClass("text-ink", "bg-surface");
  });

  it("gives a kind the icon of its family, and an unknown kind the food-shop icon", () => {
    const pub = render(<KindTile category="pub" size="row" />);
    const bar = render(<KindTile category="bar" size="row" />);
    expect(svgOf(pub.container)!.innerHTML).toBe(svgOf(bar.container)!.innerHTML);

    const unknown = render(<KindTile category="spaceport_canteen" size="row" />);
    const shop = render(<KindTile category="deli" size="row" />);
    expect(svgOf(unknown.container)!.innerHTML).toBe(svgOf(shop.container)!.innerHTML);
  });

  it.each([
    ["card", ["size-13", "rounded-tile"], "size-[26px]"],
    ["row", ["size-11", "rounded-[12px]"], "size-[22px]"],
    ["page", ["size-14", "rounded-[16px]", "wide:size-16", "wide:rounded-[18px]"], "size-7"],
  ] as const)("draws the %s tile at the design's size", (size, tileClasses, iconClass) => {
    const { container } = render(<KindTile category="cafe" size={size} />);
    expect(container.firstElementChild).toHaveClass(...tileClasses);
    expect(container.firstElementChild!.firstElementChild).toHaveClass(iconClass);
  });

  it("sits on white on a tinted card, and inverts on a chain row", () => {
    const ground = render(<KindTile category="cafe" size="card" tone="ground" />);
    expect(ground.container.firstElementChild).toHaveClass("bg-ground", "text-ink");
    const ink = render(<KindTile category="cafe" size="row" tone="ink" />);
    expect(ink.container.firstElementChild).toHaveClass("bg-emphasis", "text-on-emphasis");
  });
});

describe("HouseName", () => {
  it("puts the house's badge in front of the house's name, the two on one line, and leaves the words as they are", () => {
    const { container } = render(<HouseName text={`Ask ${copy.house.name} first.`} size="line" />);
    expect(container.textContent).toBe(`Ask ${copy.house.name} first.`);
    const badge = container.querySelector("img")!;
    expect(badge).toHaveAttribute("alt", "");
    expect(badge.parentElement).toHaveClass("whitespace-nowrap");
    expect(badge.parentElement!.textContent).toBe(copy.house.name);
    expect(badge.parentElement!.firstChild).toBe(badge);
  });

  it("keeps each line as tall as the lines around it", () => {
    const { container } = render(
      <>
        <HouseName text={copy.house.name} size="line" />
        <HouseName text={copy.house.name} size="body" />
      </>,
    );
    const [line, body] = container.querySelectorAll("img");
    expect(line).toHaveClass("size-5", "-my-0.5", "align-text-bottom");
    expect(body).toHaveClass("size-6", "-my-1", "align-text-bottom");
  });

  it("draws a text that does not name the house as it is, with no badge", () => {
    const { container } = render(<HouseName text="Scores from the people you trust." size="body" />);
    expect(container.innerHTML).toBe("Scores from the people you trust.");
  });
});

describe("the scroll position", () => {
  it("goes to the top on a new page and comes back to where it was on Back", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(240);
    const { router } = renderApp("/");

    await act(() => router.navigate("/map"));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

    scrollY.mockReturnValue(0);
    await act(() => router.navigate(-1));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 240);
  });

  describe("of a page the person opened afresh, which the router calls 'default' like the first page of a tab", () => {
    const POSITIONS = "react-router-scroll-positions";
    let scrolledTo: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrolledTo = vi.fn();
      Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrolledTo });
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });

    it("goes to the section a link names, not to where the page that was in the tab before it was left", () => {
      // The tab's last first page was left at the top, and kept as "default".
      window.sessionStorage.setItem(POSITIONS, JSON.stringify({ default: 0 }));
      const scrollTo = vi.spyOn(window, "scrollTo");
      renderApp("/about#how-scores-work");
      expect(scrolledTo).toHaveBeenCalled();
      expect(scrolledTo.mock.contexts.at(-1)).toBe(document.getElementById("how-scores-work"));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("keeps its own position for the address it has, so a reload comes back to where it was", () => {
      window.sessionStorage.setItem(POSITIONS, JSON.stringify({ default: 0, "/about?x=1#signing-in": 300 }));
      const scrollTo = vi.spyOn(window, "scrollTo");
      renderApp("/about?x=1#signing-in");
      // The router goes to the section as the page opens, and then to the position kept for this address.
      expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
    });

    it("keeps a page the person went to by the router's own key, as before", async () => {
      const scrollTo = vi.spyOn(window, "scrollTo");
      const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(120);
      const { router } = renderApp("/about#signing-in");
      scrolledTo.mockClear();
      await act(() => router.navigate("/map"));
      scrollY.mockReturnValue(0);
      await act(() => router.navigate(-1));
      // Back to a hash link as the person left it: the position they had, not the section again.
      expect(scrollTo).toHaveBeenLastCalledWith(0, 120);
    });
  });
});

describe("the document title", () => {
  it.each([
    ["/", "Regulars"],
    ["/map", "Map · Regulars"],
    ["/search?q=pizza", "Search · Regulars"],
    ["/filters", "Filters · Regulars"],
    ["/place/osm-node-11330857543", "Jacafé · Regulars"],
    ["/place/osm-node-123", "No longer listed · Regulars"],
    ["/chain/copper-kettle-pt", "No longer listed · Regulars"],
    ["/about", "About · Regulars"],
    ["/signin", "Sign in · Regulars"],
    ["/saved", "Saved · Regulars"],
    ["/you", "You · Regulars"],
    ["/no/such/page", "Not found · Regulars"],
  ])("at %s is %j", (path, title) => {
    renderApp(path);
    expect(document.title).toBe(title);
  });

  it("follows the person from page to page", async () => {
    const { router } = renderApp("/");
    await act(() => router.navigate("/saved"));
    expect(document.title).toBe(copy.titles.saved);
    await act(() => router.navigate("/"));
    expect(document.title).toBe(copy.titles.explore);
  });

  it("is the app's name for Explore, and each other page's name before it", () => {
    expect(copy.titles.explore).toBe(copy.app.name);
    for (const [page, title] of Object.entries(copy.titles)) {
      // A page named after what it shows (a place) gives its name to its title.
      const text = typeof title === "function" ? title("Sample") : title;
      if (page !== "explore") expect(text).toMatch(new RegExp(` · ${copy.app.name}$`));
    }
  });

  describe("useDocumentTitle", () => {
    it("sets the title, changes it with its argument, and puts the old one back when it goes", () => {
      document.title = "Before";
      const { rerender, unmount } = renderHook(({ title }) => useDocumentTitle(title), { initialProps: { title: "One" } });
      expect(document.title).toBe("One");
      rerender({ title: "Two" });
      expect(document.title).toBe("Two");
      unmount();
      expect(document.title).toBe("Before");
    });

    it("sets the title as the page is drawn, not after it", async () => {
      // Outside `act`, as a page drawn after its places arrive is: the commit is one task, and the
      // effects that wait for paint run in a later one. The page is on screen by the first microtask.
      const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        document.title = "Before";
        function Page() {
          useDocumentTitle("Drawn");
          return <h1>Page</h1>;
        }
        const seen = await new Promise<string>((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            resolve(document.title);
          });
          observer.observe(container, { childList: true, subtree: true });
          root.render(<Page />);
        });
        expect(seen).toBe("Drawn");
      } finally {
        root.unmount();
        container.remove();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
      }
    });
  });
});

describe("the account button", () => {
  it("is marked as the current page on You", () => {
    renderApp("/you", { width: DESKTOP });
    expect(screen.getByRole("link", { name: copy.nav.account })).toHaveAttribute("aria-current", "page");
  });

  it("is not marked anywhere else", () => {
    for (const [path, width] of [
      ["/saved", DESKTOP],
      ["/", PHONE],
    ] as const) {
      const { unmount } = renderApp(path, { width });
      expect(screen.getByRole("link", { name: copy.nav.account })).not.toHaveAttribute("aria-current");
      unmount();
    }
  });
});

describe("the location in the search field", () => {
  it("cuts a long place name short inside the pill, so the field keeps its shape", () => {
    renderApp("/", { width: DESKTOP });
    const pill = within(screen.getByRole("search")).getByRole("button", { name: "Near Funchal" });
    const label = within(pill).getByText("Near Funchal");
    expect(label).toHaveClass("truncate");
    expect(label.className).toMatch(/\bmax-w-/);
  });
});

describe("the production markup", () => {
  it("carries no test hooks: tests find things by role and name", () => {
    const files = readdirSync(resolve(process.cwd(), "src"), { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.tsx?$/.test(file),
    );
    expect(files.length).toBeGreaterThan(20);
    const offences = files.filter((file) => /data-testid/.test(readFileSync(resolve(process.cwd(), "src", file), "utf8")));
    expect(offences).toEqual([]);
  });
});

describe("the copy", () => {
  it("is the wording of the design and the plan", () => {
    expect([copy.nav.explore, copy.nav.map, copy.nav.saved, copy.nav.you]).toEqual(["Explore", "Map", "Saved", "You"]);
    expect(copy.nav.account).toBe("Your account and your circle");
    expect(copy.search.placeholder).toBe("Tacos, coffee, a place name");
    expect(copy.search.label).toBe("Search places");
    expect([copy.view.house, copy.view.circle]).toEqual(["House picks", "My circle"]);
    expect(copy.load.retry).toBe("Try again");
    expect(copy.load.loading).toBe("Finding places…");
    expect(copy.offline).toBe("You're offline. Showing places saved on this device.");
    expect(copy.location.finding).toBe("Finding your location…");
  });
});
