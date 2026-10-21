import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HERE_STORAGE_KEY } from "../src/location/useLocation";
import type { RelayReader } from "../src/nostr/events";
import { writeSaved } from "../src/places/cache";
import { distanceKm, formatDistance } from "../src/places/distance";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { TOWNS_WAIT_MS } from "../src/places/store";
import { forgetSavedFloor } from "../src/saved/change";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { hex64 } from "./support/events";
import { type AddOn, asksFirst, gate, signedInAs } from "./support/followPage";
import { type RelayOptions, strangers, type World } from "./support/followWorld";
import { createMemoryReader } from "./support/memoryReader";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import { asksForSaved, SAVED_RELAYS, savedWorld, setUpSavedRelays } from "./support/savedWorld";
import {
  JACAFE,
  newWorld,
  places,
  profileOf,
  rankOf,
  readersOf,
  reviewOfPlace,
  SEARCH,
  type World as Reviews,
  writersOf,
} from "./support/reviewWorld";

/*
 * The Saved page (src/saved/SavedPage.tsx), in the app itself, over the person's saved places on five
 * relays held in memory: the sign-in prompt for someone signed out; for someone signed in, while the
 * list is read, when it could not be, empty, and the places it holds as Explore draws them, newest
 * saved first; a saved place that came off the map, with Remove from list, which takes it out by the
 * real `changeSaved`; and what the page leaves out. The keys are thrown away, and nothing opens a socket.
 */

// The sign-in page looks for an add-on a moment after the page loads: here it has just loaded, and
// the look ends at once with what the page has (src/signin/addOn.ts, whose clock tests/addOn.test.ts plays).
vi.mock("../src/signin/addOn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/addOn")>();
  return { ...actual, msSinceLoad: () => 0, lookForAddOn: async () => actual.hasAddOn() };
});

const SECRET = generateSecretKey();

const LISTED = parsePlaces(places);
const byD = (d: string) => LISTED.find((place) => place.d === d)!;
/** Three places of the list. */
const FIRST = JACAFE;
const SECOND = byD("osm-node-3884132779");
const THIRD = byD("osm-node-1782789982");
/** The address of a place of the house's that is not on the list: it came off the map. */
const GONE = `39999:${config.houseHex}:osm-node-1`;
/** The same kind of address from another curator: no place of this app's. */
const ANOTHER_CURATORS = `39999:${hex64("c")}:${SECOND.d}`;

/** Where the person is: a town of their own picking, which no town of the list's stands in for. */
const HERE = { name: "Somewhere", country: "XX", lat: 32.65, lon: -16.91 };

/** A place's entry in a list, as a save writes it. */
const entry = (address: string) => ["a", address, config.placesRelay];

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** A list of the person's saved places, truly signed, with `tags` after its name and title: the oldest saved first. */
const savedList = (...tags: string[][]): NostrEvent =>
  asSent(
    finalizeEvent({ kind: 30003, created_at: 1_700_000_000, tags: [["d", "regulars-saved"], ["title", "Saved places"], ...tags], content: "" }, SECRET),
  );

/** The places the newest saved list on the relay at `url` holds. */
const placesOn = (w: World, url: string) =>
  w.relays[url]!.held.filter((event) => event.kind === 30003)
    .sort((a, b) => b.created_at - a.created_at)[0]
    ?.tags.filter((tag) => tag[0] === "a")
    .map((tag) => tag[1]);

/** Makes every saved-list relay fail every read, or answer again. */
function setDown(w: World, down: boolean): void {
  for (const url of SAVED_RELAYS) w.relays[url]!.down = down;
}

/** Relays whose answers to a request for a saved list wait until the gate they come with is opened. */
function heldBack() {
  const answer = gate();
  const relays: RelayOptions = {
    reads: (reader) => ({
      async *req(filter, signal) {
        if (asksForSaved(filter)) await answer.closed;
        yield* reader.req(filter, signal);
      },
    }),
  };
  return { relays, open: answer.open };
}

/**
 * A reader of the places relay that fills every page it is asked for with the list's places over and
 * over: the load goes on to a second page, which adds no place, and stops there short of its end.
 */
const neverEnding: RelayReader = {
  async *req(filter, signal) {
    const limit = filter.limit ?? places.length;
    for (let i = 0; i < limit; i++) {
      signal.throwIfAborted();
      yield places[i % places.length]!;
    }
  },
};

interface Opening {
  px?: number;
  /** The lists each saved-list relay holds. Default: none, so the person has saved nothing. */
  lists?: NostrEvent[];
  /** Whether the person is signed in with this tab's add-on as the app opens. Default: yes. */
  signIn?: boolean;
  /** How each saved-list relay answers. */
  relays?: RelayOptions;
  /** Whether every saved-list relay is down as the app opens. Default: no. */
  down?: boolean;
  /** The history, ending at the page that is open. Default: Saved alone. */
  entries?: string[];
  /** The places relay's reader. Default: one over the list's places, which sends them whole. */
  placesReader?: RelayReader;
  /** The reviews, the house's ranks and the reviewers' names. Default: none. */
  reviews?: Reviews;
}

/**
 * The app at Saved (or the end of `entries`), with the person's saved places on five relays held in
 * memory and the reviews and the house's ranks on the review world's. It resolves once the page is
 * past the "Finding places" line.
 */
async function openSaved({ px = PHONE, lists = [], signIn = true, relays, down = false, entries = ["/saved"], placesReader, reviews = newWorld() }: Opening = {}) {
  const w = savedWorld(lists, relays);
  setDown(w, down);
  const addOn: AddOn | undefined = signIn ? signedInAs(SECRET) : undefined;
  const app = await openApp(entries.at(-1)!, {
    events: places,
    px,
    entries,
    placesReader,
    readers: (url) => w.relays[url]?.reader ?? readersOf(reviews)(url),
    writers: (url) => w.relays[url]?.writer ?? writersOf(reviews)(url),
  });
  return { ...app, w, addOn };
}

/** The page's entries, in order: the items of the list named Saved, a card or a place that came off the map each; none while there is no list. */
const shown = () => {
  const list = screen.queryByRole("list", { name: copy.pages.saved });
  return list === null ? [] : within(list).getAllByRole("listitem");
};
/** The card of `place`: a link to it, named by its name. */
const cardOf = (place: Place) => screen.getByRole("link", { name: place.name });
/** The entries of saved places that came off the map. */
const goneEntries = () => shown().filter((item) => within(item).queryByText(copy.place.noLongerListed) !== null);
/** Remove from list, on the page. */
const removeButton = () => screen.getByRole("button", { name: copy.saved.removeFromList });

/** The person, at a keyboard and a pointer, with the fake clock moved on as they wait. */
const person = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

/** What the app logs: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  setUpSavedRelays(config);
  strangers.length = 0;
  forgetSavedFloor();
  window.localStorage.setItem(HERE_STORAGE_KEY, JSON.stringify(HERE));
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetWidth();
    Reflect.deleteProperty(window, "nostr");
    window.sessionStorage.clear();
  }
});

// ---------------------------------------------------------------------------------------------

describe("Saved, for someone signed out", () => {
  it("asks the person to sign in, as before, and reads nobody's list", async () => {
    const { w } = await openSaved({ signIn: false });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.pages.saved);
    expect(screen.getByText(copy.saved.signedOut)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.signin.button })).toHaveAttribute("href", "/signin");
    expect(screen.queryByText(copy.saved.public)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(w.asked().filter(asksForSaved)).toEqual([]);
  });
});

describe("Saved, for someone signed in", () => {
  it("is a tab on a phone and a link in the desktop's top bar, each the page that is open", async () => {
    await openSaved();
    const tabs = screen.getByRole("navigation", { name: copy.nav.label });
    expect(within(tabs).getAllByRole("link").map((tab) => tab.textContent)).toEqual(["Explore", "Map", "Trending", "Saved", "You"]);
    expect(within(tabs).getByRole("link", { name: copy.nav.saved })).toHaveAttribute("aria-current", "page");
    cleanup();

    await openSaved({ px: DESKTOP });
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: copy.nav.saved })).toHaveAttribute("aria-current", "page");
  });

  it("says it is finding the places while the list is read, then shows them", async () => {
    const reads = heldBack();
    const { router } = await openSaved({ lists: [savedList(entry(FIRST.address))], relays: reads.relays, entries: ["/"] });
    await act(() => router.navigate("/saved"));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.pages.saved);
    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: FIRST.name })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();

    await reads.open();
    await screen.findByRole("link", { name: FIRST.name });
    expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument();
  });

  it("says the list couldn't be loaded, with Try again, which reads it again, the focus kept on the page", async () => {
    const user = person();
    const { w } = await openSaved({ lists: [savedList(entry(FIRST.address))], down: true });
    const said = await screen.findByText(copy.saved.failed);
    expect(copy.saved.failed).toBe("We couldn't load your saved places.");
    expect(said).toHaveAttribute("role", "alert");
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();
    const again = screen.getByRole("button", { name: copy.saved.tryAgain });

    setDown(w, false);
    await user.click(again);
    await screen.findByRole("link", { name: FIRST.name });
    expect(screen.queryByText(copy.saved.failed)).not.toBeInTheDocument();
    // Try again went with the line: the focus is on what holds the list, not lost to the page.
    expect(document.activeElement).toContainElement(cardOf(FIRST));
  });

  it("says when it is empty, under the line that the saved places are public", async () => {
    await openSaved();
    expect(await screen.findByText(copy.saved.empty)).toBeInTheDocument();
    expect(copy.saved.empty).toBe("Nothing saved yet. Save a place to keep it here.");
    expect(screen.getByText(copy.saved.public)).toBeInTheDocument();
    expect(copy.saved.public).toBe("Saved places are public. Anyone can see them.");
    expect(shown()).toEqual([]);
  });

  it("shows the places newest saved first, as Explore's cards, under the line that they are public", async () => {
    await openSaved({ lists: [savedList(entry(FIRST.address), entry(SECOND.address), entry(THIRD.address))] });
    await screen.findByRole("link", { name: THIRD.name });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.pages.saved);
    const line = screen.getByText(copy.saved.public);
    expect(screen.getByRole("heading", { level: 1 }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(shown().map((item) => within(item).getByRole("link").getAttribute("href"))).toEqual(
      [THIRD, SECOND, FIRST].map((place) => `/place/${encodeURIComponent(place.d)}`),
    );
    // Each card says what the place is and how far it is from where the person is, as Explore's do.
    for (const place of [FIRST, SECOND, THIRD]) {
      const km = distanceKm(HERE.lat, HERE.lon, place.lat, place.lon);
      expect(within(cardOf(place)).getByText(copy.explore.kindLine(placeKindLabel(place.category, place.cuisine), formatDistance(km, "en-US")))).toBeInTheDocument();
    }
    // Nobody has reviewed them: each card says so, once the reviews are read.
    for (const place of [FIRST, SECOND, THIRD]) expect(await within(cardOf(place)).findByText(copy.score.noReviewsYet)).toBeInTheDocument();
    expect(goneEntries()).toEqual([]);
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();
  });

  it("lays the cards out in a grid on a desktop, and one under another on a phone", async () => {
    const lists = [savedList(entry(FIRST.address), entry(SECOND.address))];
    await openSaved({ lists });
    const phone = (await screen.findByRole("link", { name: FIRST.name })).closest("ul")!;
    expect(phone).toHaveClass("flex", "flex-col", "wide:grid");
    cleanup();

    await openSaved({ px: DESKTOP, lists });
    const desktop = (await screen.findByRole("link", { name: FIRST.name })).closest("ul")!;
    expect(desktop).toHaveClass("wide:grid", "wide:grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]");
  });

  it("leaves out what the app doesn't know as a place: another app's entries, another curator's places", async () => {
    await openSaved({
      lists: [
        savedList(
          entry(FIRST.address),
          ["a", `30023:${hex64("d")}:a-post`, "wss://elsewhere.example.test"],
          ["e", hex64("e")],
          ["t", "coffee"],
          entry(ANOTHER_CURATORS),
        ),
      ],
    });
    await screen.findByRole("link", { name: FIRST.name });
    expect(shown()).toHaveLength(1);
    expect(goneEntries()).toEqual([]);
    expect(screen.queryByRole("link", { name: SECOND.name })).not.toBeInTheDocument();
  });

  it("shows each place's score in the view on screen, as Explore's cards do, and no number about a person", async () => {
    const ALICE = hex64("a");
    const BOB = hex64("b");
    const RANKS = [82.5];
    config.reviewRelays = [SEARCH];
    const reviews = newWorld();
    reviews.search.push(profileOf(ALICE, "Alice"), profileOf(BOB, "Bob"), reviewOfPlace(ALICE, FIRST, 5, "Lovely"), reviewOfPlace(BOB, SECOND, 2, "Meh"));
    reviews.ranks.push(rankOf(ALICE, RANKS[0]!));
    await openSaved({ lists: [savedList(entry(FIRST.address), entry(SECOND.address), entry(THIRD.address))], reviews });

    // Its score in the view on screen (House picks), as Explore's card shows it; a place only others
    // have rated is dashed, with no rating yet; a place nobody has reviewed says so.
    expect(await within(cardOf(FIRST)).findByText(/^[\d.]+ out of 5$/)).toBeInTheDocument();
    await waitFor(() => expect(within(cardOf(SECOND)).getByText(copy.score.noScoreYet)).toBeInTheDocument());
    expect(cardOf(SECOND)).toHaveClass("border-dashed");
    expect(within(cardOf(THIRD)).getByText(copy.score.noReviewsYet)).toBeInTheDocument();
    expectNoNumbersAboutPeople(RANKS);
  });
});

describe("a saved place that came off the map", () => {
  it("says it is no longer listed, with Remove from list, which takes it out of the list", async () => {
    const user = person();
    const { w, addOn } = await openSaved({ lists: [savedList(entry(GONE), entry(FIRST.address))] });
    await screen.findByRole("link", { name: FIRST.name });

    // Newest saved first: the place on the map, then the one that came off it, in its own entry.
    const [first, second] = shown() as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("link", { name: FIRST.name })).toBeInTheDocument();
    expect(goneEntries()).toEqual([second]);
    expect(within(second).getByText(copy.place.noLongerListed)).toBeInTheDocument();
    expect(within(second).getByText(copy.place.noLongerListedDetail)).toBeInTheDocument();
    expect(within(second).queryByRole("link")).not.toBeInTheDocument();
    expect(copy.saved.removeFromList).toBe("Remove from list");

    const approve = asksFirst(addOn!, SECRET);
    await user.click(removeButton());
    // While it is taken out: Saving…, and a press does nothing more.
    const saving = await within(second).findByRole("button", { name: copy.saved.saving });
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(saving).toHaveFocus();
    await user.click(saving);
    await user.keyboard("{Enter}");

    await approve.yes();
    await waitFor(() => expect(goneEntries()).toEqual([]));
    expect(addOn!.signEvent).toHaveBeenCalledTimes(1);
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([FIRST.address]);
    // The focus, which was on the entry that went, is on what holds the list, not lost to the page.
    expect(document.activeElement).toContainElement(cardOf(FIRST));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("puts the focus on what held the list when the only entry is taken out, and says there are none", async () => {
    const user = person();
    const { w } = await openSaved({ lists: [savedList(entry(GONE))] });
    await screen.findByText(copy.place.noLongerListed);
    expect(shown()).toHaveLength(1);

    await user.click(removeButton());
    const empty = await screen.findByText(copy.saved.empty);
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([]);
    // The entry that had the focus went, and the list with it: the focus is on the region that held it, not lost to the page.
    const region = empty.parentElement!;
    expect(region).toHaveAttribute("tabindex", "-1");
    expect(region).toHaveFocus();
  });

  it("says so when it was not taken out, with Try again, which takes it out", async () => {
    const user = person();
    const { w, addOn } = await openSaved({ lists: [savedList(entry(FIRST.address), entry(GONE))] });
    await screen.findByText(copy.place.noLongerListed);

    addOn!.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    await user.click(removeButton());
    const line = await screen.findByText(copy.saved.notApproved);
    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(goneEntries()).toHaveLength(1);
    const again = screen.getByRole("button", { name: copy.saved.tryAgain });
    expect(again).toHaveAttribute("aria-describedby", line.id);
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([FIRST.address, GONE]);

    await user.click(again);
    await waitFor(() => expect(goneEntries()).toEqual([]));
    expect(screen.queryByText(copy.saved.notApproved)).not.toBeInTheDocument();
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([FIRST.address]);
  });

  it("is left out while the places on screen are this device's copy: the latest may have it", async () => {
    await writeSaved({ events: places, savedAt: Date.now(), complete: true });
    await openSaved({
      lists: [savedList(entry(FIRST.address), entry(GONE))],
      placesReader: createMemoryReader([], { failWith: new Error("The places relay is down") }),
    });
    await screen.findByRole("link", { name: FIRST.name });
    expect(shown()).toHaveLength(1);
    expect(screen.queryByText(copy.place.noLongerListed)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.saved.removeFromList })).not.toBeInTheDocument();
  });

  it("leaves the page finding the places, with no empty list, while the latest may still come and none of the list is in this device's copy", async () => {
    await writeSaved({ events: places, savedAt: Date.now(), complete: true });
    const latest = gate();
    const placesReader: RelayReader = {
      async *req(filter, signal) {
        await latest.closed;
        yield* createMemoryReader(places).req(filter, signal);
      },
    };
    const { router, w } = await openSaved({ lists: [savedList(entry(GONE))], placesReader, entries: ["/"] });
    await act(() => router.navigate("/saved"));
    // The person's list has been read: it holds one place, which this device's copy has not got.
    await waitFor(() => expect(w.asked().filter(asksForSaved)).toHaveLength(SAVED_RELAYS.length));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByText(copy.load.loading)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("list", { name: copy.pages.saved })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();

    // The latest comes, whole, without it: it came off the map.
    await latest.open();
    await screen.findByText(copy.place.noLongerListed);
    expect(goneEntries()).toHaveLength(1);
    expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument();
  });

  it("says the places couldn't be loaded, with Try again, when the latest could not be and none of the list is in this device's copy", async () => {
    const user = person();
    await writeSaved({ events: places, savedAt: Date.now(), complete: true });
    let placesDown = true;
    const placesReader: RelayReader = {
      async *req(filter, signal) {
        if (placesDown) throw new Error("The places relay is down");
        yield* createMemoryReader(places).req(filter, signal);
      },
    };
    await openSaved({ lists: [savedList(entry(GONE))], placesReader });

    expect(await screen.findByText(copy.load.failed)).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("list", { name: copy.pages.saved })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();

    // Try again loads the latest, which comes whole without it: it came off the map.
    placesDown = false;
    await user.click(screen.getByRole("button", { name: copy.load.retry }));
    await screen.findByText(copy.place.noLongerListed);
    expect(goneEntries()).toHaveLength(1);
    expect(screen.queryByText(copy.load.failed)).not.toBeInTheDocument();
  });

  it("says the places couldn't be loaded, with Try again, when they came from a load that stopped short and none of the list is among them", async () => {
    await openSaved({ lists: [savedList(entry(GONE))], placesReader: neverEnding });

    expect(await screen.findByText(copy.load.failed)).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: copy.load.retry })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: copy.pages.saved })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.saved.empty)).not.toBeInTheDocument();
  });

  it("is left out while the places on screen came from a load that stopped short of the list's end", async () => {
    await openSaved({ lists: [savedList(entry(FIRST.address), entry(GONE))], placesReader: neverEnding });
    await screen.findByRole("link", { name: FIRST.name });
    expect(shown()).toHaveLength(1);
    expect(screen.queryByText(copy.place.noLongerListed)).not.toBeInTheDocument();
  });
});

describe("Saved while saving is closed", () => {
  it("says, to someone signed in, that saving opens soon, with no way to sign in again, and reads no list", async () => {
    config.features.saved = false;
    const { w } = await openSaved({ lists: [savedList(entry(FIRST.address))] });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.pages.saved);
    expect(screen.getByText(copy.saved.soon)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.signin.button })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: FIRST.name })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(w.asked().filter(asksForSaved)).toEqual([]);
  });
});
