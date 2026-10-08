import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSession, SESSION_KEY } from "../src/account/session";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader, RelayWriter } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import { REVIEW_KIND } from "../src/reviews/review";
import { reviewTemplate } from "../src/reviews/write";
import { HELD_REVIEWS_KEY } from "../src/score/store";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { createMemoryWriter, type MemoryWriter } from "./support/memoryWriter";

/*
 * Rating a place (M2b Task 6; screen 8 and D3; ruling R12): the form, posting it, the person's own
 * review shown before the relays send it back, and the ways in and out of the form, signed in or
 * not, on a phone and on a desktop. Relays are held in memory; nothing opens a socket.
 */

const places: NostrEvent[] = raw;
const JACAFE = parsePlaces(places).find((place) => place.d === "osm-node-11330857543")!;
const PLACE_PATH = `/place/${JACAFE.d}`;
const REVIEW_PATH = `${PLACE_PATH}/review`;

/** Brainstorm's search relay (reviews, names), the house's trust relay, the relay-list directory, and a relay the person writes to. */
const SEARCH = "wss://search.brainstorm.world";
const TRUST = "wss://scores.brainstorm.world";
const DIRECTORY = "wss://purplepag.es";
const OWN = "wss://nos.example.test";
/** A made-up scorer and its relay: the house's real one is never written into the app or its tests. */
const SCORER = hex64("5");
const SCORER_RELAY = "wss://ranks.example.test";

/** Thursday 8 October 2026, 12:00 UTC, in seconds: the time the tests' reviews are posted at. */
const NOW_S = 1_791_460_800;

/** The house's kind 10040, naming `SCORER` at `SCORER_RELAY`. */
const trustList = () => shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", SCORER, SCORER_RELAY]] });

/** `SCORER`'s kind 30382 giving `subject` the rank `rank`. */
const rankOf = (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", subject], ["rank", String(rank)]] });

/** `pubkey`'s profile (kind 0) naming them `name`. */
const profileOf = (pubkey: string, name: string) => shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });

/** `pubkey`'s relay list (kind 10002), writing to `urls`. */
const listOf = (pubkey: string, urls: string[]) => shapedEvent({ kind: 10002, pubkey, tags: urls.map((url) => ["r", url]) });

/** `reviewer`'s review of Jacafé, as the app writes them. */
const reviewBy = (reviewer: string, stars: number, text: string, createdAt = NOW_S - 86_400) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: createdAt,
    content: text,
    tags: [
      ["d", `place:${JACAFE.address}`],
      ["a", JACAFE.address],
      ["m", "place"],
      ["s", String(stars)],
    ],
  });

/**
 * What the relays hold, each a list the test may change between reads: the search relay's reviews
 * and profiles, the directory's relay lists, and the scorer's ranks. Each reader reads its list as
 * it is at the time of the request.
 */
interface World {
  search: NostrEvent[];
  directory: NostrEvent[];
  ranks: NostrEvent[];
  /** The relays that are sent reviews, by URL. One not here refuses. */
  writers: Record<string, MemoryWriter>;
}

function newWorld(): World {
  return { search: [], directory: [], ranks: [], writers: {} };
}

const readersOf =
  (world: World) =>
  (url: string): RelayReader => {
    if (url === SEARCH) return createMemoryReader(world.search);
    if (url === TRUST) return createMemoryReader([trustList()]);
    if (url === SCORER_RELAY) return createMemoryReader(world.ranks);
    if (url === DIRECTORY) return createMemoryReader(world.directory);
    return createMemoryReader([]);
  };

const writersOf =
  (world: World) =>
  (url: string): RelayWriter =>
    world.writers[url] ?? createMemoryWriter({ refuse: "not in this test" });

/** What the relay at `url` was sent. */
const sentTo = (world: World, url: string): NostrEvent[] => world.writers[url]?.published ?? [];

/** The browser add-on (NIP-07) as a page sees it, signing with `key`. */
function installAddOn(key: Uint8Array) {
  const addOn = {
    getPublicKey: vi.fn(async () => getPublicKey(key)),
    signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, key)),
  };
  Object.defineProperty(window, "nostr", { configurable: true, writable: true, value: addOn });
  return addOn;
}

/**
 * The person, signed in with this browser in this tab before the page was opened, named `name` on
 * the search relay. `signsWith` is the key their add-on signs with now: another person's when it
 * has changed accounts since.
 */
function signedIn(world: World, { name = "Maya", signsWith }: { name?: string; signsWith?: Uint8Array } = {}) {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const addOn = installAddOn(signsWith ?? key);
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
  world.search.push(profileOf(pubkey, name));
  return { key, pubkey, addOn, name };
}

/** The history of a person who opened the place from Explore and is now at `path`. */
const fromExplore = (...paths: string[]) => ["/", ...paths];

/** The app at the end of `entries`, reading and writing `world`. */
const open = (world: World, entries: Parameters<typeof openApp>[1]["entries"], px = PHONE) =>
  openApp(String(entries?.at(-1)), { events: places, entries, px, readers: readersOf(world), writers: writersOf(world) });

/**
 * The first "Rate this place" on the page, once there is one (a phone's score panel has none while
 * the place's reviews are read): on a desktop, the one in the rail.
 */
const rateLink = async () => {
  const rail = screen.queryByRole("complementary", { name: copy.place.railLabel });
  return (await within(rail ?? document.body).findAllByRole("link", { name: copy.place.rate }))[0]!;
};

/** The stars, one to five: the radios of "How was it?". */
const starButtons = async () => within(await screen.findByRole("radiogroup", { name: copy.review.howWasIt })).getAllByRole("radio");

/** The Post button, by its name before posting. */
const postButton = () => screen.getByRole("button", { name: copy.review.post });

/** The same button once a post has failed: Try again. */
const tryAgainButton = () => screen.getByRole("button", { name: copy.review.tryAgain });

/**
 * The element whose whole text is `text`, and none of whose children's is: a line with a name in it,
 * which the name's own element (a `<bdi>`) splits into several text nodes.
 */
const wholeText = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text && ![...element.children].some((child) => child.textContent === text);

/** "Reviewing as <name>", once the form knows who is signed in. */
const reviewingAs = (name: string, inside: Pick<typeof screen, "findByText"> = screen) =>
  inside.findByText(wholeText(copy.review.reviewingAs(name)));

/**
 * A review's words as the place's page lists them. Not the form's text box, which holds the same words
 * (React keeps a text box's value as its text too) until the form has gone.
 */
const reviewWords = (text: string) => screen.findByText(text, { selector: "article p" });
const noReviewWords = (text: string) => screen.queryByText(text, { selector: "article p" });

/** What the tab holds of the person's own reviews, before the relays send them back. */
const heldText = () => window.sessionStorage.getItem(HELD_REVIEWS_KEY);

beforeEach(() => {
  config.reviewRelays = [SEARCH];
  // The clock stands still at NOW_S: what a review is stamped with is known.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW_S * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
});

describe("the review form (Review.dc.html, DeskReview.dc.html)", () => {
  it("has five star buttons with the design's words, the text box, the notice, and Post off until a star is chosen", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    expect(await reviewingAs(me.name)).toBeInTheDocument();
    expect(screen.getByText(copy.review.yourReviewOf)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: JACAFE.name })).toBeInTheDocument();
    expect(document.title).toBe(copy.titles.review(JACAFE.name));

    expect(copy.review.starWords).toEqual(["Would not go back", "Below average", "Fine", "Good", "One of the best"]);
    const stars = await starButtons();
    expect(stars).toHaveLength(5);
    stars.forEach((star, i) => {
      expect(star).toHaveAccessibleName(copy.review.star(i + 1));
      expect(star).toHaveAttribute("aria-checked", "false");
      // 56 px, the design's size, over the 44 px a finger needs.
      expect(star).toHaveClass("size-14");
    });
    expect(copy.review.star(1)).toBe("1 star, Would not go back");
    expect(copy.review.star(4)).toBe("4 stars, Good");

    const text = screen.getByRole("textbox", { name: copy.review.textLabel });
    expect(copy.review.textLabel).toBe("What should a friend know?");
    expect(text).toHaveValue("");
    expect(screen.getByText(copy.review.notice)).toBeInTheDocument();
    expect(copy.review.notice).toBe("Reviews are public and carry your name. One review per place: posting again replaces this one.");

    // Off until a star is chosen: pressing it does nothing.
    const post = postButton();
    expect(post).toHaveAttribute("aria-disabled", "true");
    await user.click(post);
    expect(me.addOn.signEvent).not.toHaveBeenCalled();

    await user.click(stars[3]!);
    expect(stars.map((star) => star.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true", "false"]);
    expect(screen.getByText("Good")).toBeInTheDocument();
    expect(post).not.toHaveAttribute("aria-disabled");
    await user.click(stars[0]!);
    expect(screen.getByText("Would not go back")).toBeInTheDocument();
    expect(screen.queryByText("Good")).not.toBeInTheDocument();
  });

  it("is filled in with the person's own review of the place, when they have one", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(reviewBy(me.pubkey, 3, "Bolo do caco, and sit outside"));
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    const stars = await starButtons();
    await waitFor(() => expect(stars[2]).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Bolo do caco, and sit outside");
    expect(screen.getByText("Fine")).toBeInTheDocument();
  });

  it("is a radio group of stars: one Tab stop, chosen with the arrow keys, Home and End", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    const stars = await starButtons();
    const tabStops = () => stars.map((star) => star.tabIndex);
    const checked = () => stars.map((star) => star.getAttribute("aria-checked"));
    // While none is chosen, the first star is the group's one Tab stop.
    expect(tabStops()).toEqual([0, -1, -1, -1, -1]);
    stars.forEach((star, i) => expect(star).toHaveAccessibleName(copy.review.star(i + 1)));

    stars[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(stars[1]).toHaveFocus();
    expect(checked()).toEqual(["false", "true", "false", "false", "false"]);
    expect(tabStops()).toEqual([-1, 0, -1, -1, -1]);
    await user.keyboard("{ArrowDown}");
    expect(stars[2]).toHaveFocus();
    await user.keyboard("{End}");
    expect(stars[4]).toHaveFocus();
    expect(screen.getByText("One of the best")).toBeInTheDocument();
    // Round the ends.
    await user.keyboard("{ArrowRight}");
    expect(stars[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(stars[4]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(stars[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(stars[4]).toHaveFocus();
    expect(checked()).toEqual(["false", "false", "false", "false", "true"]);

    // The Tab key comes into the group at the star chosen.
    await user.click(stars[2]!);
    screen.getByRole("link", { name: copy.review.back }).focus();
    await user.tab();
    expect(stars[2]).toHaveFocus();
  });

  it("names the person who is reviewing, and never a number about them", async () => {
    const world = newWorld();
    const me = signedIn(world, { name: "Sofia" });
    world.ranks.push(rankOf(me.pubkey, 73));
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    expect(await reviewingAs("Sofia")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b73\b|%|rank|weight/i);
  });
});

describe("posting a review", () => {
  it("signs it with the person's signer, sends it to the review relay and the relays they write to, and goes back to the place", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter({ into: world.search });
    world.writers[OWN] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    // Signed in, Rate this place opens the form.
    expect(await rateLink()).toHaveAttribute("href", REVIEW_PATH);
    await user.click(await rateLink());
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());

    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
    const [sent] = sentTo(world, SEARCH);
    expect(sent).toBeDefined();
    expect(verifyEvent(sent!)).toBe(true);
    expect(sent).toMatchObject({ ...reviewTemplate(JACAFE, 4, "Get the bolo", NOW_S), pubkey: me.pubkey });
    expect(sentTo(world, OWN)).toEqual([sent]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);

    // The place shows it at once.
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
  });

  it("says it is saved to the person's own places but not to Regulars when only their own relay takes it, and holds nothing (R13)", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "rate-limited" });
    world.writers[OWN] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[4]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Worth it");
    await user.click(postButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.notOnRegulars);
    expect(copy.review.notOnRegulars).toBe("Saved to your own places, but not to Regulars yet. Try again.");
    expect(sentTo(world, OWN)).toHaveLength(1);
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Worth it");
    expect(heldText()).toBeNull();

    // Try again, and the review relay takes it this time.
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)[0]).toMatchObject({ content: "Worth it" });
    expect(heldText()).not.toBeNull();
  });

  it("says it didn't post, keeping what was typed, when every relay refuses it; and nothing of it is shown or held", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const stars = await starButtons();
    await user.click(stars[1]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Slow tonight");
    await user.click(postButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(copy.review.failed).toBe("Your review didn't post. Try again.");
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Slow tonight");
    expect(stars[1]).toHaveAttribute("aria-checked", "true");
    expect(heldText()).toBeNull();
    expect(tryAgainButton()).not.toHaveAttribute("aria-disabled");
    expect(copy.review.tryAgain).toBe("Try again");

    // The relay takes it the second time.
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)[0]).toMatchObject({ content: "Slow tonight" });
  });

  it("says it didn't post when there is nowhere to send it, and asks nobody to sign", async () => {
    config.reviewRelays = [];
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await user.click((await starButtons())[2]!);
    await user.click(postButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(me.addOn.signEvent).not.toHaveBeenCalled();
  });

  it("posts once when Post is pressed twice before the page has redrawn: one signing, one send", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    const form = postButton().closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(sentTo(world, SEARCH)).toHaveLength(1);
  });

  it("says Posting… in a polite live region while it posts", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ silent: true });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const form = postButton().closest("form")!;
    const live = within(form).getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(live).toHaveTextContent(copy.review.posting));
    expect(copy.review.posting).toBe("Posting…");
  });

  it("stamps an edit made in the same second one second after the review it replaces, so it replaces it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    await user.click(await rateLink());
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    // Again, in the same second: the form has the review just posted, and the edit is stamped after it.
    await user.click(await rateLink());
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    await user.click(stars[4]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    expect(sentTo(world, SEARCH).map((ev) => ev.created_at)).toEqual([NOW_S, NOW_S + 1]);
    expect(sentTo(world, SEARCH).map((ev) => ev.tags.find((tag) => tag[0] === "s")?.[1])).toEqual(["4", "5"]);
  });
});

describe("the person's own review, before the relays send it back (Review Focus 1)", () => {
  it("shows at once, and after a reload, until a read returns it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    // The relay takes the review, and does not send it back yet: it lags.
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();

    // The page is reloaded before the relay sends it back: still shown, from what the tab keeps.
    cleanup();
    await open(world, [PLACE_PATH]);
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    expect(heldText()).not.toBeNull();

    // The relay sends it back: the tab keeps it no longer.
    world.search.push(sentTo(world, SEARCH)[0]!);
    cleanup();
    await open(world, [PLACE_PATH]);
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    await waitFor(() => expect(heldText()).toBeNull());

    // So once the relay drops it, it is gone.
    world.search.splice(world.search.indexOf(sentTo(world, SEARCH)[0]!), 1);
    cleanup();
    await open(world, [PLACE_PATH]);
    expect(await screen.findByText(copy.place.beFirst)).toBeInTheDocument();
    expect(noReviewWords("Get the bolo")).not.toBeInTheDocument();
  });
});

describe("signing in to rate", () => {
  it("takes a person who is signed out from Rate this place to sign in, and then to the form", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    installAddOn(key);
    world.search.push(profileOf(getPublicKey(key), "Maya"));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    expect(await rateLink()).toHaveAttribute("href", "/signin");
    await user.click(await rateLink());
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: PLACE_PATH }, next: { pathname: REVIEW_PATH } });

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(await reviewingAs("Maya")).toBeInTheDocument();

    // The way back from the form is the place, as the sign-in page is gone from the history.
    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
  });

  it.each([
    ["another site", { pathname: "//example.com/place/x/review" }],
    ["the sign-in page itself", { pathname: "/signin" }],
    ["not a page", "/place/x/review"],
  ])("goes back where the person came from when where they were going is %s", async (_, next) => {
    const world = newWorld();
    installAddOn(generateSecretKey());
    const user = userEvent.setup();
    const place = { pathname: PLACE_PATH, search: "", hash: "" };
    const { router } = await open(world, [PLACE_PATH, { pathname: "/signin", state: { from: place, next } }]);

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
  });

  it("opens the form in place of sign in when sign in was the first page opened, with the place as its way back", async () => {
    const world = newWorld();
    installAddOn(generateSecretKey());
    const user = userEvent.setup();
    const place = { pathname: PLACE_PATH, search: "", hash: "" };
    const { router } = await open(world, [{ pathname: "/signin", state: { from: place, next: { pathname: REVIEW_PATH } } }]);

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    // Nothing is behind it in the history: its way back puts the place in its stead.
    await user.click(await screen.findByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("goes back to the place, not to sign in, when the person keeps House picks", async () => {
    const world = newWorld();
    installAddOn(generateSecretKey());
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    await user.click(await rateLink());
    await user.click(screen.getByRole("link", { name: copy.signin.keepHousePicks }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
  });

  it("sends the person to sign in when their add-on has changed accounts, and back to the form with what they typed", async () => {
    const world = newWorld();
    const now = generateSecretKey();
    const me = signedIn(world, { signsWith: now });
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[4]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Worth the wait");
    await user.click(postButton());

    // Signed out, and at sign in, which comes back here.
    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
    expect(readSession()).toBeNull();
    expect(sentTo(world, SEARCH)).toEqual([]);
    expect(router.state.location.state).toMatchObject({ from: { pathname: REVIEW_PATH } });

    await user.click(await screen.findByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    const stars = await starButtons();
    expect(stars[4]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Worth the wait");

    // Posted as the person the add-on signs as now.
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)[0]).toMatchObject({ pubkey: getPublicKey(now), content: "Worth the wait" });
  });

  it("forgets the person's review held for this tab when they sign out", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    // The relay takes it, and lags: the review is held.
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    expect(heldText()).not.toBeNull();

    await act(() => router.navigate("/you"));
    await user.click(await screen.findByRole("button", { name: copy.you.signOut }));
    expect(heldText()).toBeNull();
    await act(() => router.navigate(PLACE_PATH));
    expect(await screen.findByText(copy.place.beFirst)).toBeInTheDocument();
    expect(noReviewWords("Get the bolo")).not.toBeInTheDocument();
  });

  it("forgets the held review when the add-on has changed accounts, and keeps the words being typed", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(heldText()).not.toBeNull();

    // The add-on now signs as someone else.
    installAddOn(generateSecretKey());
    await user.click(await rateLink());
    const stars = await starButtons();
    await user.click(stars[1]!);
    const text = screen.getByRole("textbox", { name: copy.review.textLabel });
    await user.clear(text);
    await user.type(text, "Changed my mind");
    await user.click(postButton());

    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
    expect(heldText()).toBeNull();
    await user.click(await screen.findByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect((await starButtons())[1]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Changed my mind");
  });

  it("sends Post to sign in from a form opened signed out, keeping what was typed", async () => {
    const world = newWorld();
    installAddOn(generateSecretKey());
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await user.click((await starButtons())[2]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Fine coffee");
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect((await starButtons())[2]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Fine coffee");
  });
});

describe("on a desktop: a dialog over the place page (DeskReview.dc.html)", () => {
  it("keeps the focus inside while it is open, and gives it back to Rate this place when Escape closes it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    const rate = await rateLink();
    await user.click(rate);
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await reviewingAs(me.name, within(dialog));
    // Over the place page, which is still there behind it.
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("complementary", { name: copy.place.railLabel })).toBeInTheDocument();

    // The focus starts at the stars, and the Tab key goes round inside.
    const stars = await starButtons();
    expect(stars[0]).toHaveFocus();
    const close = within(dialog).getByRole("button", { name: copy.review.close });
    const post = within(dialog).getByRole("button", { name: copy.review.post });
    post.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(post).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(await rateLink()).toHaveFocus();
  });

  it("closes with its cross, and after posting, back to the place page with the review on it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    await user.click(await rateLink());
    await user.click(await screen.findByRole("button", { name: copy.review.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await rateLink()).toHaveFocus();

    await user.click(await rateLink());
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await reviewingAs(me.name, within(dialog));
    await user.click((await starButtons())[4]!);
    await user.type(within(dialog).getByRole("textbox", { name: copy.review.textLabel }), "Best pastel de nata");
    await user.click(within(dialog).getByRole("button", { name: copy.review.post }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(await reviewWords("Best pastel de nata")).toBeInTheDocument();
  });

  it("starts the focus at the star chosen, when the person's review fills the form in", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 3, "Bolo do caco"));
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH), DESKTOP);

    // The place has read the person's review.
    expect(await reviewWords("Bolo do caco")).toBeInTheDocument();
    await user.click(await rateLink());
    await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    const stars = await starButtons();
    expect(stars[2]).toHaveAttribute("aria-checked", "true");
    expect(stars[2]).toHaveFocus();
  });

  it("stops posting when it is closed while the review is being sent, and holds nothing", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const silent = createMemoryWriter({ silent: true });
    world.writers[SEARCH] = silent;
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    await user.click(await rateLink());
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await reviewingAs(me.name, within(dialog));
    await user.click((await starButtons())[3]!);
    await user.click(within(dialog).getByRole("button", { name: copy.review.post }));
    await waitFor(() => expect(silent.signals).toHaveLength(1));
    expect(silent.signals[0]!.aborted).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: copy.review.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(silent.signals[0]!.aborted).toBe(true);
    expect(heldText()).toBeNull();
  });
});

describe("on a phone: a page of its own (Review.dc.html)", () => {
  it("is at /place/:d/review in place of the place's page, with a back arrow to the place", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    await user.click(await rateLink());
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    await starButtons();
    // The place's own page is not under it.
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const back = screen.getByRole("link", { name: copy.review.back });
    expect(back).toHaveAttribute("href", PLACE_PATH);
    await user.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
  });

  it("goes to the place by its back arrow when the form was the first page opened", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, [REVIEW_PATH]);

    await user.click(await screen.findByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("stops posting when its back arrow is used while the review is being sent", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const silent = createMemoryWriter({ silent: true });
    world.writers[SEARCH] = silent;
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(silent.signals).toHaveLength(1));

    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(silent.signals[0]!.aborted).toBe(true);
    expect(heldText()).toBeNull();
  });
});
