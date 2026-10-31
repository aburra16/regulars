import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, type RouteObject, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountProvider } from "../src/account/AccountProvider";
import { WHY_PATH } from "../src/circle/paths";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { personPath } from "../src/person/npub";
import { buildIndexes, chainSlug } from "../src/places/indexes";
import { parsePlaces } from "../src/places/load";
import type { PlacesValue } from "../src/places/store";
import { routes } from "../src/routes";
import { ScoresProvider } from "../src/score/ScoresProvider";
import { FramedLink } from "../src/shell/Framed";
import { TONES } from "../src/ui/BuiltOnBrainstorm";
import { DESKTOP, openApp, PHONE, resetWidth, resizeTo, setWidth } from "./support/app";
import { hex64 } from "./support/events";
import { JACAFE, newWorld, PLACE_PATH, places, profileOf, readersOf, REVIEW_PATH, SEARCH, signedIn, writersOf } from "./support/reviewWorld";

/*
 * Where "Built on Brainstorm" is: at the foot of every page, once and only once.
 * The shell draws it, in a footer of its own after the page, for every page that scrolls; the desktop's
 * list beside the map draws it as the last line of the list's own footer, and the shell then draws none;
 * the phone's map, which is all map, has none. (tests/builtOnBrainstorm.test.tsx has the line itself.)
 *
 * The places are the fixture's, the relays are held in memory, and nothing opens a socket.
 */

// `value` replaces what usePlaces gives; undefined: the real store.
const placesOverride = vi.hoisted(() => ({ value: undefined as PlacesValue | undefined }));
vi.mock("../src/places/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/store")>();
  return { ...actual, usePlaces: () => placesOverride.value ?? actual.usePlaces() };
});

const NAME = `Built on Brainstorm ${copy.common.newTab}`;

/** A reviewer, Sol. The key is made up. */
const SOL = hex64("c");
/** A chain the fixture has: four A Confeitaria Coffee & Bakery, all in Funchal. */
const CHAIN = buildIndexes(parsePlaces(places)).chains.get("PT:a confeitaria coffee & bakery")!;

/**
 * Every "Built on Brainstorm" on the page: Brainstorm's shared element, found by what it is and not by
 * its role. A dialog over a page hides the page from a screen reader, and the line is still on it.
 */
const lines = () => [...document.querySelectorAll<HTMLElement>("built-on-brainstorm")];
const main = () => document.querySelector("main")!;
/** The footers that are not a page's own: outside `main`. */
const shellFeet = () => [...document.querySelectorAll("footer")].filter((footer) => !main().contains(footer));
/** What can be pressed in `foot`: its links and buttons, and the line, whose link is in its own shadow root. */
const pressable = (foot: Element) => [...foot.querySelectorAll("a, button, built-on-brainstorm")];

/** The one line the page has, which is the link it should be. */
function theLine(): HTMLElement {
  const all = lines();
  expect(all).toHaveLength(1);
  const [line] = all as [HTMLElement];
  const link = line.shadowRoot!.querySelector("a")!;
  expect(link).toHaveAccessibleName(NAME);
  expect(link).toHaveAttribute("href", "https://brainstorm.world");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  return line;
}

/**
 * Where a page has the line: in the shell's own footer; in the footer of the desktop's list beside the
 * map; in the page itself, under what it says (a page that broke where the shell draws no foot); or nowhere.
 */
type Where = "shell" | "list" | "page" | "none";

function expectLine(where: Where): void {
  if (where === "none") {
    expect(lines()).toEqual([]);
    expect(shellFeet()).toEqual([]);
    return;
  }
  const line = theLine();
  if (where === "shell") {
    // In a footer of the shell's own, outside the page and after it: the one landmark of its kind.
    const feet = shellFeet();
    expect(feet).toHaveLength(1);
    const [foot] = feet as [HTMLElement];
    expect(foot).toContainElement(line);
    expect(main().compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pressable(foot)).toEqual([line]);
    expect(screen.getAllByRole("contentinfo", { hidden: true }).filter((each) => !main().contains(each))).toEqual([foot]);
    return;
  }
  if (where === "page") {
    // The last thing in the page, under what it says, and no footer of the shell's.
    expect(shellFeet()).toEqual([]);
    const foot = line.closest("footer")!;
    expect(main().lastElementChild).toBe(foot);
    expect(document.querySelectorAll("footer")).toHaveLength(1);
    expect(pressable(foot)).toEqual([line]);
    expect(within(main()).getByRole("alert").compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    return;
  }
  // The last line of the list's own footer, in the list's column, and no footer of the shell's.
  expect(shellFeet()).toEqual([]);
  const foot = line.closest("footer")!;
  expect(main()).toContainElement(foot);
  const column = foot.closest("section")!;
  expect(column).toContainElement(screen.getByRole("heading", { level: 1 }));
  // The column scrolls, not the window, and holds what is drawn out of the flow inside it: the words a
  // screen reader alone has, of this line and of the link to add a missing place, are not placed down
  // the page, where they made the window scroll too (seen in a browser: jsdom lays nothing out).
  expect(column).toHaveClass("overflow-y-auto", "relative");
  expect(foot.lastElementChild).toContainElement(line);
  expect(within(foot).getByRole("link", { name: copy.common.aboutData }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

/** The app at `path`, over a search relay that has Sol's profile, with the person signed in or not. */
async function open(path: string, px: number, signed: boolean, entries?: string[]) {
  config.reviewRelays = [SEARCH];
  const world = newWorld();
  world.search.push(profileOf(SOL, "Sol"));
  if (signed) signedIn(world);
  return openApp(path, { events: places, px, entries, readers: readersOf(world), writers: writersOf(world) });
}

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });

/**
 * Every route of src/routes.tsx: its address, how a test knows its page is in, and where the line is
 * on a phone and on a desktop. A function of whether the person is signed in where that changes the
 * page: the sign-in page takes a person who is signed in back to Explore.
 */
type Place = Where | ((signed: boolean) => Where);
const ROUTES: ReadonlyArray<readonly [name: string, path: string, settled: (signed: boolean, px: number) => Promise<unknown>, phone: Place, desktop: Place]> = [
  ["Explore", "/", () => heading(copy.pages.explore), "shell", "list"],
  // All map on a phone; a desktop has the map on Explore, and this goes there.
  ["the map", "/map", (_, px) => heading(px === PHONE ? copy.pages.map : copy.pages.explore), "none", "list"],
  ["search", "/search?q=cafe", () => heading(copy.pages.search), "shell", "list"],
  // A desktop has the filters as menus over the list: this goes to the search results.
  ["filters", "/filters", (_, px) => heading(px === PHONE ? copy.pages.filters : copy.pages.search), "shell", "list"],
  ["Trending", "/trending", () => heading(copy.pages.recent), "shell", "shell"],
  ["Trending by its old address", "/recent", () => heading(copy.pages.recent), "shell", "shell"],
  ["a place", PLACE_PATH, () => heading(JACAFE.name), "shell", "shell"],
  // A page of its own on a phone; on a desktop a dialog over the place's page, which has no line of its own.
  ["a place's review form", REVIEW_PATH, () => screen.findByRole("radiogroup", { name: copy.review.howWasIt }), "shell", "shell"],
  ["a place that is not listed", "/place/osm-node-123", () => heading(copy.place.noLongerListed), "shell", "shell"],
  ["a chain", `/chain/${chainSlug(CHAIN)}`, () => heading(CHAIN.name), "shell", "shell"],
  ["a person", personPath(SOL), () => heading("Sol"), "shell", "shell"],
  ["a person's address that names nobody", "/person/sol", () => screen.findByText(copy.missing.text), "shell", "shell"],
  ["About", "/about", () => heading(copy.about.title), "shell", "shell"],
  ["Why", WHY_PATH, () => heading(copy.why.title), "shell", "shell"],
  [
    "sign-in",
    "/signin",
    (signed) => heading(signed ? copy.pages.explore : copy.signin.headline),
    "shell",
    (signed) => (signed ? "list" : "shell"),
  ],
  ["Saved", "/saved", () => heading(copy.pages.saved), "shell", "shell"],
  ["You", "/you", (signed) => heading(signed ? "Maya" : copy.pages.you), "shell", "shell"],
  ["an address with no page", "/no/such/page", () => screen.findByText(copy.missing.text), "shell", "shell"],
];

let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  placesOverride.value = undefined;
  logs = (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  // Nothing the line or its footer does is warned of, or reported as an error.
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
});

describe("every page has the line once, and only once", () => {
  it("covers every route the app has", () => {
    const [shell] = routes;
    const [pages] = shell!.children!;
    const written = pages!.children!.flatMap((route) => [route, ...(route.children ?? []).map((child) => ({ ...child, path: `${route.path}/${child.path}` }))]);
    // Each route's address as a pattern: a parameter is anything but a slash, and the last route is every address left.
    const patterns = written.map((route) =>
      route.index === true ? /^\/$/ : route.path === "*" ? /^\/.*$/ : new RegExp(`^/${route.path!.replace(/:[a-z]+/g, "[^/]+")}$`),
    );
    expect(patterns).toHaveLength(16);
    const paths = ROUTES.map(([, path]) => path.replace(/\?.*$/, ""));
    // Every route is opened by a test below, at the first pattern its address meets, as the router has it.
    const met = new Set(paths.map((path) => patterns.findIndex((pattern) => pattern.test(path))));
    expect([...met].sort((a, b) => a - b)).toEqual(patterns.map((_, i) => i));
  });

  describe.each([
    ["signed out", false],
    ["signed in", true],
  ] as const)("%s", (_, signed) => {
    it.each(ROUTES)("on a phone: %s", async (_name, path, settled, phone) => {
      await open(path, PHONE, signed);
      await settled(signed, PHONE);
      expectLine(typeof phone === "function" ? phone(signed) : phone);
    });

    it.each(ROUTES)("on a desktop: %s", async (_name, path, settled, _phone, desktop) => {
      await open(path, DESKTOP, signed);
      await settled(signed, DESKTOP);
      expectLine(typeof desktop === "function" ? desktop(signed) : desktop);
    });
  });

  it("keeps the one line as the person goes from page to page, and as the window crosses to a desktop's width and back", async () => {
    const { router } = await open("/", PHONE, false);
    expectLine("shell");
    for (const [path, where] of [
      ["/map", "none"],
      [PLACE_PATH, "shell"],
      ["/about", "shell"],
      ["/signin", "shell"],
      ["/", "shell"],
    ] as const) {
      await act(() => router.navigate(path));
      expect(router.state.location.pathname).toBe(path);
      await waitFor(() => expectLine(where));
    }
    // The same Explore, laid out the other way: the list beside the map has the line, and the shell none.
    act(() => resizeTo(DESKTOP));
    await waitFor(() => expectLine("list"));
    act(() => resizeTo(PHONE));
    await waitFor(() => expectLine("shell"));
  });
});

describe("where the shell draws the line", () => {
  it("is above the phone's tabs, between the page and them, so the tabs do not cover it", async () => {
    await open("/trending", PHONE, false);
    const [foot] = shellFeet() as [HTMLElement];
    const tabs = screen.getByRole("navigation", { name: copy.nav.label });
    expect(main().nextElementSibling).toBe(foot);
    expect(foot.nextElementSibling).toBe(tabs);
    // In the page's flow, not laid over it: it takes its own room above the tabs, which stay at the foot of the screen.
    expect(foot.className).not.toMatch(/(?:^|\s)(?:fixed|sticky|absolute)(?:\s|$)/);
    expect(tabs).toHaveClass("sticky", "bottom-0");
  });

  it("is the last thing on a page with no tabs, after the page's own footer and its credit", async () => {
    await open(PLACE_PATH, PHONE, false);
    await heading(JACAFE.name);
    const [foot] = shellFeet() as [HTMLElement];
    const own = main().querySelector("footer")!;
    expect(within(own).getByRole("link", { name: copy.common.aboutData })).toBeInTheDocument();
    expect(own.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: copy.nav.label })).not.toBeInTheDocument();
    // Nothing of the page comes after it but the bar about the person's circle, which is empty and takes no room.
    expect(foot.nextElementSibling).toBe(screen.getAllByRole("status").at(-1)!.parentElement);
  });

  it("is centred on a phone, and at the start of the content column on a desktop", async () => {
    await open("/about", PHONE, false);
    const [foot] = shellFeet() as [HTMLElement];
    const column = theLine().parentElement!;
    expect(foot).toContainElement(column);
    expect(column).toHaveClass("flex", "justify-center", "px-gutter-phone");
    expect(column).toHaveClass("wide:mx-auto", "wide:max-w-content", "wide:justify-start", "wide:px-gutter-desktop");
  });

  it("is on the sign-in page's dark ground there, in both themes, and on the page's ground everywhere else", async () => {
    for (const px of [PHONE, DESKTOP]) {
      const signin = await open("/signin", px, false);
      const [foot] = shellFeet() as [HTMLElement];
      expect(foot, `${px} px`).toHaveClass("bg-night", "on-dark");
      expect(foot).toHaveAttribute("data-theme", "light");
      expect(theLine()).toHaveClass(...TONES.night.split(" "));
      signin.unmount();

      const about = await open("/about", px, false);
      const [plain] = shellFeet() as [HTMLElement];
      expect(plain.className, `${px} px`).not.toMatch(/night|on-dark/);
      expect(plain).not.toHaveAttribute("data-theme");
      expect(theLine()).toHaveClass(...TONES.page.split(" "));
      about.unmount();
    }
  });
});

describe("while the places load, or could not be loaded", () => {
  const none: PlacesValue = { status: "loading", places: [], source: "network", complete: false, retry: () => {} };
  const ready: PlacesValue = { status: "ready", places: parsePlaces(places), source: "network", complete: true, retry: () => {} };

  /** The app at `path` with the places as `value` has them, drawn at once: `openApp` waits for the loading line to go. */
  function draw(path: string, px: number, value: PlacesValue) {
    placesOverride.value = value;
    setWidth(px);
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    return render(
      <ScoresProvider>
        <AccountProvider>
          <HereProvider>
            <RouterProvider router={router} />
          </HereProvider>
        </AccountProvider>
      </ScoresProvider>,
    );
  }

  it.each([
    ["a phone's Explore", "/", PHONE],
    ["a phone's place page", PLACE_PATH, PHONE],
    ["a desktop's place page", PLACE_PATH, DESKTOP],
    // A page that fills the window has no page of its own yet: the shell's line stands in, and does not come in later.
    ["a desktop's Explore", "/", DESKTOP],
    ["a desktop's search", "/search?q=cafe", DESKTOP],
    ["the phone's map", "/map", PHONE],
  ] as const)("the line is there already, under the loading line: %s", (_, path, px) => {
    draw(path, px, none);
    expect(within(main()).getByText(copy.load.loading)).toBeInTheDocument();
    expectLine("shell");
  });

  it.each([
    ["a desktop's Explore", "/", DESKTOP],
    ["the phone's map", "/map", PHONE],
  ] as const)("the page that says the places could not be loaded has it: %s", (_, path, px) => {
    draw(path, px, { ...none, status: "error", error: "network" });
    expect(within(main()).getByRole("alert")).toHaveTextContent(copy.load.failed);
    expectLine("shell");
  });

  it.each([
    ["a desktop's Explore, whose list beside the map has it", "/", DESKTOP, "list"],
    ["the phone's map, which has none", "/map", PHONE, "none"],
  ] as const)("the shell's line goes once the places are in on a page that fills the window: %s", (_, path, px, where) => {
    const loading = draw(path, px, none);
    expectLine("shell");
    loading.unmount();
    draw(path, px, ready);
    expectLine(where);
  });
});

describe("a page that broke", () => {
  function Broken(): ReactNode {
    throw new Error("TypeError: cannot read properties of undefined");
  }

  it("has the line, in the shell's footer, when the page broke inside the app", () => {
    placesOverride.value = { status: "ready", places: parsePlaces(places), source: "network", complete: true, retry: () => {} };
    const [shell] = routes;
    const [pages] = shell!.children!;
    const broken = [{ ...shell, children: [{ ...pages, children: [{ path: "broken", element: <Broken /> }, ...pages!.children!] }] }] as RouteObject[];
    setWidth(PHONE);
    render(
      <HereProvider>
        <RouterProvider router={createMemoryRouter(broken, { initialEntries: ["/broken"] })} />
      </HereProvider>,
    );
    expect(within(main()).getByText(copy.broken.text)).toBeInTheDocument();
    expectLine("shell");
    // React reports what broke; the page does not show it.
    for (const log of logs) log.mockClear();
  });

  /**
   * The app with the page of one of its own routes throwing as it is drawn (`path` as routes.tsx writes
   * it; "" for Explore). The route's handle is as it was, so what the shell has around the page is too:
   * a page that fills the window still does.
   */
  function drawBroken(path: string, at: string, px: number) {
    placesOverride.value = { status: "ready", places: parsePlaces(places), source: "network", complete: true, retry: () => {} };
    const [shell] = routes;
    const [pages] = shell!.children!;
    const own = (route: RouteObject) => (route.index === true ? "" : route.path);
    expect(pages!.children!.filter((route) => own(route) === path)).toHaveLength(1);
    const children = pages!.children!.map((route) => (own(route) === path ? { ...route, element: <Broken />, children: undefined } : route));
    setWidth(px);
    const view = render(
      <ScoresProvider>
        <AccountProvider>
          <HereProvider>
            <RouterProvider router={createMemoryRouter([{ ...shell, children: [{ ...pages, children }] }] as RouteObject[], { initialEntries: [at] })} />
          </HereProvider>
        </AccountProvider>
      </ScoresProvider>,
    );
    // The page says it broke, inside the app; React reports what broke, and the page does not show it.
    expect(within(main()).getByRole("alert")).toHaveTextContent(copy.broken.text);
    expect(document.body).not.toHaveTextContent(/TypeError|undefined/);
    for (const log of logs) log.mockClear();
    return view;
  }

  it.each([
    ["a desktop's Explore", "", "/", DESKTOP],
    ["a desktop's search", "search", "/search?q=cafe", DESKTOP],
    ["the phone's map", "map", "/map", PHONE],
  ] as const)("has the line once where the page that broke fills the window, and the shell draws no foot: %s", (_, path, at, px) => {
    drawBroken(path, at, px);
    // The list beside the map, which would have drawn it, is not there: the page that says so draws it.
    expectLine("page");
    // On a phone it is above the tabs, which are still there to leave by.
    const tabs = screen.queryByRole("navigation", { name: copy.nav.label });
    if (px === PHONE) expect(main().nextElementSibling).toBe(tabs);
    else expect(tabs).toBeNull();
  });

  it.each([
    ["a phone's Explore", "", "/", PHONE],
    ["a phone's search", "search", "/search?q=cafe", PHONE],
    ["a phone's Trending", "trending", "/trending", PHONE],
    ["a phone's About", "about", "/about", PHONE],
    ["a phone's place", "place/:d", PLACE_PATH, PHONE],
    ["a desktop's Trending", "trending", "/trending", DESKTOP],
    ["a desktop's About", "about", "/about", DESKTOP],
    ["a desktop's place", "place/:d", PLACE_PATH, DESKTOP],
    ["a desktop's sign-in", "signin", "/signin", DESKTOP],
  ] as const)("still has it once, the shell's and no other, where the page that broke scrolls: %s", (_, path, at, px) => {
    drawBroken(path, at, px);
    expectLine("shell");
    expect(main().querySelector("footer")).toBeNull();
  });

  it("has the line when the app's own frame broke, and the page that says so stands alone", () => {
    const [shell] = routes;
    const broken = [{ ...shell, element: <Broken /> }] as RouteObject[];
    setWidth(PHONE);
    render(<RouterProvider router={createMemoryRouter(broken, { initialEntries: ["/"] })} />);
    expect(within(main()).getByText(copy.broken.text)).toBeInTheDocument();
    expect(within(main()).getByRole("link", { name: copy.broken.home })).toHaveAttribute("href", "/");
    expectLine("shell");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    for (const log of logs) log.mockClear();
  });
});

describe("the site in another site's frame", () => {
  it("has no line: only the link that opens it on its own", () => {
    render(<FramedLink />);
    expect(screen.getByRole("link", { name: copy.framed.open })).toBeInTheDocument();
    expect(lines()).toEqual([]);
    expect(document.querySelector("footer")).toBeNull();
    expect(document.body).not.toHaveTextContent("Built on Brainstorm");
  });
});
