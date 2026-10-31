import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as nip19 from "nostr-tools/nip19";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { fetchedPersonPage, loadPersonPage } from "../src/person/loadPersonPage";
import { personPath, toNpub } from "../src/person/npub";
import * as pageCode from "../src/person/PersonPage";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { hex64 } from "./support/events";
import { newWorld, places, profileOf, readersOf, SEARCH, writersOf } from "./support/reviewWorld";

/*
 * The route of a person's page, `/person/<npub>` (src/person/PersonRoute.tsx): an address that names
 * nobody has no page; the page's code is a chunk of its own, fetched when a person's page is first
 * opened, with the loading line meanwhile and the error page if it cannot be fetched; and the focus
 * goes to the page's heading as it does on every other page, though the heading comes in late.
 * (tests/personPage.test.tsx and its neighbours have the page itself; tests/relay-chunk.test.ts, that
 * the build keeps its code out of the entry.)
 *
 * The fetch of the page's code is played here: a test holds it, ends it, or fails it. The relays are
 * held in memory, and nothing opens a socket.
 */

vi.mock("../src/person/loadPersonPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/person/loadPersonPage")>();
  return { loadPersonPage: vi.fn(actual.loadPersonPage), fetchedPersonPage: vi.fn(actual.fetchedPersonPage) };
});
const load = vi.mocked(loadPersonPage);
const fetched = vi.mocked(fetchedPersonPage);

/** A reviewer, Sol. The key is made up. */
const SOL = hex64("c");
const SOL_PATH = personPath(SOL);

/** The page's code is on the device already: fetched on an earlier visit. */
function fetchedBefore(): void {
  fetched.mockReturnValue(pageCode);
}

/** The page's code has not been fetched: each fetch of it goes on until the test ends it, with the code or without. */
function notFetchedYet() {
  let arrive!: (code: typeof pageCode) => void;
  let fail!: (error: unknown) => void;
  const fetching = new Promise<typeof pageCode>((resolve, reject) => {
    arrive = resolve;
    fail = reject;
  });
  // Nothing waits on a fetch that failed once the page has gone.
  fetching.catch(() => {});
  fetched.mockReturnValue(undefined);
  load.mockImplementation(() => fetching);
  return {
    arrives: () => act(async () => arrive(pageCode)),
    fails: () => act(async () => fail(new TypeError("Failed to fetch dynamically imported module"))),
  };
}

/** The app at `path`, with Sol's profile on the search relay. */
async function open(path: string, opts: { px?: number; entries?: string[]; strict?: boolean } = {}) {
  config.reviewRelays = [SEARCH];
  const world = newWorld();
  world.search.push(profileOf(SOL, "Sol"));
  return openApp(path, { events: places, readers: readersOf(world), writers: writersOf(world), ...opts });
}

const main = () => screen.getByRole("main");
const pageHeading = () => within(main()).findByRole("heading", { level: 1, name: "Sol" });

let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  load.mockReset();
  fetched.mockReset();
  logs = (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  // Nothing the route does is warned of, or reported as an error: not a fetch that failed, either.
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  resetWidth();
});

describe("an address that names nobody", () => {
  const npub = toNpub(SOL);

  it.each([
    ["a key in hex", `/person/${SOL}`],
    ["a code cut short", `/person/${npub.slice(0, 40)}`],
    ["a code with one letter wrong", `/person/${npub.slice(0, -1)}${npub.endsWith("q") ? "p" : "q"}`],
    ["a code of another kind: a note's", `/person/${nip19.noteEncode(hex64("a"))}`],
    ["a code with a relay in it", `/person/${nip19.nprofileEncode({ pubkey: SOL, relays: ["wss://nos.example.test"] })}`],
    ["a word", "/person/sol"],
    ["no code", "/person"],
    ["something after the code", `${SOL_PATH}/reviews`],
  ])("has the not-found page, and fetches nothing: %s", async (_, path) => {
    await open(path);

    expect(within(main()).getByText(copy.missing.text)).toBeInTheDocument();
    expect(within(main()).getByRole("link", { name: copy.missing.home })).toHaveAttribute("href", "/");
    expect(document.title).toBe(copy.titles.missing);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("opens the page of the same person for their code written in upper case", async () => {
    fetchedBefore();
    await open(`/person/${npub.toUpperCase()}`);

    expect(await pageHeading()).toBeInTheDocument();
  });
});

describe("the page's code, fetched when a person's page is first opened", () => {
  it("shows the loading line while it is fetched, under the person's name in the tab, and then the page", async () => {
    const code = notFetchedYet();
    await open(SOL_PATH);

    expect(within(main()).getByRole("status")).toHaveTextContent(copy.person.loading);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    // The tab is named for the person from the start, never for the page before.
    await waitFor(() => expect(document.title).toBe(copy.titles.person("Sol")));
    expect(load).toHaveBeenCalledTimes(1);

    await code.arrives();

    expect(await pageHeading()).toBeInTheDocument();
    expect(within(main()).queryByText(copy.person.loading, { selector: "p[role=status]" })).not.toBeInTheDocument();
    expect(document.title).toBe(copy.titles.person("Sol"));
  });

  it("draws the page at once when the code is there already, and fetches nothing", async () => {
    fetchedBefore();
    await open(SOL_PATH);

    expect(await pageHeading()).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("shows the page that says something went wrong when it cannot be fetched, warns of nothing, and fetches it again on the next visit", async () => {
    const code = notFetchedYet();
    const { router } = await open(SOL_PATH, { entries: ["/about", SOL_PATH] });

    await code.fails();

    const alert = within(main()).getByRole("alert");
    expect(alert).toHaveTextContent(copy.broken.text);
    expect(within(main()).getByRole("link", { name: copy.broken.home })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    // The shell's foot is under it, as under any page that scrolls: the page that says so draws none of its own.
    const built = [...document.querySelectorAll("built-on-brainstorm")];
    expect(built).toHaveLength(1);
    expect(main()).not.toContainElement(built[0] as HTMLElement);

    // A failed fetch is not remembered: the next visit asks again, and this time it comes.
    await act(() => router.navigate(-1));
    const again = notFetchedYet();
    await act(() => router.navigate(SOL_PATH));
    expect(within(main()).getByRole("status")).toHaveTextContent(copy.person.loading);
    await again.arrives();
    expect(await pageHeading()).toBeInTheDocument();
  });

  it("takes nothing from a fetch that ends after the person has left the page", async () => {
    const code = notFetchedYet();
    const { router } = await open(SOL_PATH);

    await act(() => router.navigate("/about"));
    await code.arrives();

    expect(await screen.findByRole("heading", { level: 1, name: copy.about.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Sol" })).not.toBeInTheDocument();
  });

  it("fetches and draws the page in React's strict mode, which runs every effect twice", async () => {
    const code = notFetchedYet();
    await open(SOL_PATH, { strict: true });
    expect(within(main()).getByRole("status")).toHaveTextContent(copy.person.loading);

    await code.arrives();

    expect(await pageHeading()).toBeInTheDocument();
  });
});

describe("the focus on a person's page", () => {
  /** The person has done something on the page they are on, and goes to Sol's. */
  async function goToSol(router: Awaited<ReturnType<typeof open>>["router"]) {
    await userEvent.setup().click(main());
    await act(() => router.navigate(SOL_PATH));
  }

  it("goes to the person's name, without scrolling, when the code is there already", async () => {
    fetchedBefore();
    const { router } = await open("/about");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await goToSol(router);

    const name = await pageHeading();
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("tabindex", "-1");
    expect(name).toHaveClass("outline-none");
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("goes to the person's name once the page is in, when its code came after", async () => {
    const code = notFetchedYet();
    const { router } = await open("/about");
    await goToSol(router);
    expect(within(main()).getByRole("status")).toHaveTextContent(copy.person.loading);
    expect(document.body).toHaveFocus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await code.arrives();

    const name = await pageHeading();
    expect(name).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("goes there in React's strict mode too", async () => {
    const code = notFetchedYet();
    const { router } = await open("/about", { strict: true });
    await goToSol(router);

    await code.arrives();

    expect(await pageHeading()).toHaveFocus();
  });

  it("is left alone on the first load, whenever the code comes", async () => {
    const code = notFetchedYet();
    await open(SOL_PATH);

    await code.arrives();

    expect(await pageHeading()).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it("is left where the person has put it while the code was fetched", async () => {
    const user = userEvent.setup();
    const code = notFetchedYet();
    const { router } = await open("/about", { px: DESKTOP });
    await goToSol(router);
    // The person goes on to the top bar meanwhile.
    await user.tab();
    const moved = document.activeElement;
    expect(moved).not.toBe(document.body);

    await code.arrives();

    expect(await pageHeading()).toBeInTheDocument();
    expect(moved).toHaveFocus();
  });

  it("is not taken by a page the person has left: the next page's heading has it", async () => {
    const code = notFetchedYet();
    const { router } = await open("/about");
    await goToSol(router);

    await act(() => router.navigate("/trending"));
    const trending = await screen.findByRole("heading", { level: 1, name: copy.pages.recent });
    expect(trending).toHaveFocus();
    await code.arrives();

    expect(trending).toHaveFocus();
  });
});
