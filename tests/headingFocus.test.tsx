import type { NostrEvent } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { createSignerApp, MemoryConnectRelay } from "./support/connectRelay";
import { createMemoryReader } from "./support/memoryReader";
import { createMemoryWriter } from "./support/memoryWriter";
import { quietPostWarnings } from "./support/postWarnings";
import {
  fromExplore,
  installAddOn,
  newWorld,
  open as openPlace,
  PLACE_PATH,
  places,
  profileOf,
  rankOf,
  rateLink,
  readersOf,
  REVIEW_PATH,
  reviewingAs,
  SEARCH,
  signedIn,
  starButtons,
  writersOf,
} from "./support/reviewWorld";

// The sign-in page looks, for a moment, for an add-on that comes late (src/signin/addOn.ts): here the
// page has just loaded, and the look ends at once with what the page has.
vi.mock("../src/signin/addOn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/addOn")>();
  return { ...actual, msSinceLoad: () => 0, lookForAddOn: async () => actual.hasAddOn() };
});

/*
 * Where the focus goes after the person goes to another page (a new pathname): to the new page's main
 * heading, for a screen reader, without scrolling; not on the first load, and not where the new page
 * puts the focus itself. The relays are held in memory; nothing opens a socket.
 */

const fixtures: NostrEvent[] = raw;
const PLACES = parsePlaces(fixtures);
/** Every relay the scores store reads, empty: no reviews, ranks or names. */
const readers = () => createMemoryReader([]);
const open = (path: string, px?: number, entries?: string[]) =>
  openApp(path, { events: fixtures, readers, ...(px === undefined ? {} : { px }), ...(entries === undefined ? {} : { entries }) });

/** The page's main heading. */
const pageHeading = () => within(screen.getByRole("main")).getByRole("heading", { level: 1 });
/** The cards Explore lists, each a link to its place. */
const cards = () => [...screen.getByRole("main").querySelectorAll<HTMLAnchorElement>('a[href^="/place/"]')];
/** A promise the test settles. */
function later<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** The name of the place a link to its page opens. */
const placeOf = (link: HTMLAnchorElement) => PLACES.find((place) => link.getAttribute("href") === `/place/${encodeURIComponent(place.d)}`)!;

afterEach(() => {
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "scrollY");
  Reflect.deleteProperty(window, "nostr");
});

describe("the focus after going to another page", () => {
  it("goes to the place's name when a card on Explore opens it, without scrolling", async () => {
    const user = userEvent.setup();
    await open("/");
    const card = cards()[0]!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(card);

    const name = await screen.findByRole("heading", { level: 1, name: placeOf(card).name });
    expect(name).toHaveFocus();
    // Focusable only from code, and drawn with no ring: it is not a control.
    expect(name).toHaveAttribute("tabindex", "-1");
    expect(name).toHaveClass("outline-none");
    expect(focus.mock.contexts.at(-1)).toBe(name);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("goes to Explore's heading on Back from the place, and leaves the scroll where the router puts it back", async () => {
    const user = userEvent.setup();
    await open("/");
    // Explore was scrolled down when the card was pressed.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
    const card = cards()[3]!;
    await user.click(card);
    expect(await screen.findByRole("heading", { level: 1, name: placeOf(card).name })).toHaveFocus();
    const scrollTo = vi.spyOn(window, "scrollTo");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(screen.getByRole("link", { name: copy.place.back }));

    await waitFor(() => expect(pageHeading()).toHaveTextContent(copy.pages.explore));
    expect(pageHeading()).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    // Back puts the page where it was, and nothing scrolls it after.
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });

  it("goes to Explore's heading on the browser's own Back, though the person has pressed nothing on the page", async () => {
    const { router } = await open("/about", undefined, ["/", "/about"]);
    expect(document.body).toHaveFocus();
    await act(() => router.navigate(-1));
    expect(router.state.historyAction).toBe("POP");
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.explore })).toHaveFocus();
  });

  it("waits for the page to come in when the places are still loading, and then goes to its heading", async () => {
    const places = later<void>();
    const memory = createMemoryReader(fixtures);
    const placesReader: RelayReader = {
      async *req(filter, signal) {
        await places.promise;
        yield* memory.req(filter, signal);
      },
    };
    const user = userEvent.setup();
    const { router } = await openApp("/about", { events: [], placesReader, readers, px: DESKTOP });
    await user.click(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.recent }));
    expect(router.state.location.pathname).toBe("/trending");
    // The frame says the places are loading: the page, and its heading, are not in yet.
    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();

    await act(async () => places.settle());
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.recent })).toHaveFocus();
  });

  it("goes to the heading of a tab's page, from the tab, which stays", async () => {
    const user = userEvent.setup();
    await open("/");
    await user.click(within(screen.getByRole("navigation", { name: copy.nav.label })).getByRole("link", { name: copy.nav.recent }));
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.recent })).toHaveFocus();
  });

  it("is left alone on the first load, and on the first load's own redirect (an old link to Recent)", async () => {
    await open("/");
    expect(document.body).toHaveFocus();
    resetWidth();
    const { router, unmount } = await open("/recent");
    await waitFor(() => expect(router.state.location.pathname).toBe("/trending"));
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.recent })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    unmount();
  });

  it("is left where the new page puts it: in the phone's search field, opened from Explore", async () => {
    const user = userEvent.setup();
    await open("/");
    await user.click(screen.getByRole("link", { name: /Tacos, coffee, a restaurant name/ }));
    expect(await screen.findByRole("searchbox", { name: copy.search.label })).toHaveFocus();
  });

  it("is left in the desktop's search field, where the person is typing, as the results open", async () => {
    const user = userEvent.setup();
    const { router } = await open("/", DESKTOP);
    const field = within(screen.getByRole("search")).getByRole("searchbox", { name: copy.search.label });
    await user.click(field);
    await user.keyboard("cafe{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    expect(field).toHaveFocus();
  });
});

describe("the focus after going to a section of a page (a link with a hash)", () => {
  /** What the router's scrolling to a section is given: jsdom lays nothing out and scrolls nothing. */
  let scrolledTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrolledTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrolledTo });
  });
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("goes to the heading of the section the link names, not the page's, without scrolling: sign in's How signing in works", async () => {
    const user = userEvent.setup();
    const { router } = await open("/signin");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(screen.getByRole("link", { name: copy.signin.howItWorks }));
    expect(router.state.location.pathname + router.state.location.hash).toBe("/about#signing-in");

    const heading = await screen.findByRole("heading", { level: 2, name: copy.about.signingInHeading });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveClass("outline-none");
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    // The router brings the section into view, as before.
    await waitFor(() => expect(scrolledTo).toHaveBeenCalled());
    expect(scrolledTo.mock.contexts.at(-1)).toBe(heading.closest("section"));
  });

  it("goes to the page's heading when the hash names nothing on it", async () => {
    const user = userEvent.setup();
    const { router } = await open("/");
    // The person has done something on the page: what comes next is their going.
    await user.click(screen.getByRole("main"));
    await act(() => router.navigate("/about#no-such-section"));
    expect(await screen.findByRole("heading", { level: 1, name: copy.about.title })).toHaveFocus();
  });
});

describe("the focus the app puts somewhere on purpose, as the page changes", () => {
  beforeEach(() => {
    config.reviewRelays = [SEARCH];
    quietPostWarnings();
  });

  /** The first star of the review form's dialog, once it is open. */
  const firstStar = async () => (await starButtons())[0]!;

  it("is left on the review dialog's first star when Rate this place signs the person in with their add-on and opens it", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    installAddOn(key);
    world.search.push(profileOf(getPublicKey(key), "Maya"));
    const user = userEvent.setup();
    const { router } = await openPlace(world, fromExplore(PLACE_PATH), DESKTOP);
    await user.click(await rateLink(world));

    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    await reviewingAs("Maya", within(await screen.findByRole("dialog", { name: copy.review.dialogLabel })));
    expect(await firstStar()).toHaveFocus();
  });

  it("is left on the dialog's first star when sign in opens the form in its place, after the phone app", async () => {
    const world = newWorld();
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    world.search.push(profileOf(app.userPubkey, "Alice"));
    const user = userEvent.setup();
    const { router } = await openApp(PLACE_PATH, {
      events: places,
      entries: fromExplore(PLACE_PATH),
      px: DESKTOP,
      readers: readersOf(world),
      writers: writersOf(world),
      relays: () => relay,
    });
    await user.click(await rateLink(world));
    expect(router.state.location.pathname).toBe("/signin");
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.copyLink }));
    await app.scan(writeText.mock.calls[0]![0]);

    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    await reviewingAs("Alice", within(await screen.findByRole("dialog", { name: copy.review.dialogLabel })));
    expect(await firstStar()).toHaveFocus();
  });

  it("is given back to Rate this place when the dialog closes after posting, as by its cross and Escape", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await openPlace(world, fromExplore(PLACE_PATH), DESKTOP);
    await user.click(await rateLink(world));
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await user.click(await firstStar());
    await user.click(within(dialog).getByRole("button", { name: copy.review.post }));

    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await rateLink(world)).toHaveFocus();
  });

  /** Signs the person in with the add-on from the desktop top bar's account button, and gives back the button that is theirs now. */
  async function signInFromTheTopBar(user: ReturnType<typeof userEvent.setup>) {
    installAddOn(generateSecretKey());
    await user.click(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.signIn }));
    return within(screen.getByRole("banner")).findByRole("link", { name: copy.nav.yourAccount });
  }

  it("is the account button's on the page the person signed in on, and the browser's Back after takes it to the next page's heading", async () => {
    const user = userEvent.setup();
    const { router } = await open("/", DESKTOP, ["/about", "/"]);
    const mine = await signInFromTheTopBar(user);
    expect(router.state.location.pathname).toBe("/");
    expect(mine).toHaveFocus();

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/about");
    expect(await screen.findByRole("heading", { level: 1, name: copy.about.title })).toHaveFocus();
  });

  it("is the account button's for the one page change it was put there for: the browser's Back after takes it to the next heading", async () => {
    const user = userEvent.setup();
    const { router } = await open("/you", DESKTOP);
    const mine = await signInFromTheTopBar(user);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await waitFor(() => expect(mine).toHaveFocus());

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/you");
    await waitFor(() => expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toHaveFocus());
  });

  it("goes to the heading of the page sign in lands back on, which puts the focus nowhere of its own", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const user = userEvent.setup();
    const { router } = await openApp("/about", { events: fixtures, readers, px: DESKTOP, relays: () => relay, entries: ["/", "/about"] });
    await user.click(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.signIn }));
    expect(router.state.location.pathname).toBe("/signin");
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.copyLink }));
    await app.scan(writeText.mock.calls[0]![0]);

    await waitFor(() => expect(router.state.location.pathname).toBe("/about"));
    expect(router.state.historyAction).toBe("POP");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: copy.about.title })).toHaveFocus());
  });
});
