import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADD_ON_TIMEOUT_MS } from "../src/account/connect";
import { readSession, SESSION_KEY } from "../src/account/session";
import { DRAFT_KEY } from "../src/review/draft";
import { PUBLISH_TIMEOUT_MS, REVIEW_RELAY_PATIENCE_MS, REVIEW_RELAY_TRIES, REVIEW_RELAY_WAITS_MS, SIGN_TIMEOUT_MS, SLOW_POST_MS } from "../src/review/post";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { REVIEW_KIND } from "../src/reviews/review";
import { REVIEW_WORDS_MAX, reviewTemplate } from "../src/reviews/write";
import { DESKTOP, openApp, PHONE, resetWidth, resizeTo } from "./support/app";
import { createSignerApp, MemoryConnectRelay } from "./support/connectRelay";
import { shapedEvent } from "./support/events";
import { createMemoryWriter } from "./support/memoryWriter";
import { postWarnings, quietPostWarnings } from "./support/postWarnings";
import {
  fromExplore,
  heldRelays,
  heldText,
  installAddOn,
  JACAFE,
  listOf,
  newWorld,
  noReviewWords,
  NOW_S,
  open,
  OWN,
  PLACE_PATH,
  places,
  postButton,
  profileOf,
  rankOf,
  rateLink,
  readersOf,
  REVIEW_PATH,
  reviewBy,
  reviewingAs,
  reviewWords,
  SEARCH,
  sentTo,
  signedIn,
  starButtons,
  tryAgainButton,
  writersOf,
} from "./support/reviewWorld";

// The sign-in page looks, for a moment, for an add-on that comes late (src/signin/addOn.ts, whose
// clock tests/addOn.test.ts plays). Here the page has just loaded and the look ends at once, with what
// the page has: no test waits on it.
vi.mock("../src/signin/addOn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/addOn")>();
  return { ...actual, msSinceLoad: () => 0, lookForAddOn: async () => actual.hasAddOn() };
});

/*
 * Rating a place (M2b Task 6; screen 8 and D3; ruling R12): the form, posting it, the person's own
 * review shown before the relays send it back, and the ways in and out of the form, signed in or
 * not, on a phone and on a desktop. Relays are held in memory; nothing opens a socket.
 */

/**
 * Holds each step back in the history until the test lets it land (`land`), as a browser's lands
 * later, on the popstate that follows: the memory router's lands at once, before anything else can
 * happen. `held` says how many steps back were asked for and are waiting.
 */
function backLikeABrowser(router: Awaited<ReturnType<typeof open>>["router"]) {
  const navigate = router.navigate.bind(router);
  const waiting: (() => Promise<void>)[] = [];
  router.navigate = ((to: Parameters<typeof navigate>[0], opts?: Parameters<typeof navigate>[1]) =>
    typeof to === "number"
      ? new Promise<void>((resolve) => {
          waiting.push(() => navigate(to).then(resolve));
        })
      : navigate(to, opts)) as typeof router.navigate;
  return {
    get held() {
      return waiting.length;
    },
    /** Lets every step back held so far land, one after another, as their popstates would. */
    land: () =>
      act(async () => {
        for (const go of waiting.splice(0)) await go();
      }),
  };
}

/** The form's polite line under the words, which says when they are at the most it takes. */
const wordsLine = () =>
  within(screen.getByRole("textbox", { name: copy.review.textLabel }).closest<HTMLElement>("section")!).getByRole("status");

/** The form's polite line under Post, whatever Post says, which says it is posting, and when Regulars is slow to take it. */
const postingLine = (form: HTMLElement) =>
  within(form.querySelector<HTMLElement>('[type="submit"]')!.closest<HTMLElement>("section")!).getByRole("status");

/** A photo's address, as another app puts one in a review (NIP-92); and a review's words. */
const PHOTO = "https://blossom.example/abc.jpg";
const WORDS = "Get the bolo de caco with garlic butter.";

/**
 * `reviewer`'s review of Jacafé as another app writes it: at the bare address, with a price ($$), how
 * they paid (Lightning) and a photo, whose address follows the words, and the app that signed it;
 * dated `createdAt`.
 */
const writtenElsewhere = (reviewer: string, createdAt: number) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: createdAt,
    content: `${WORDS}\n${PHOTO}`,
    tags: [
      ["d", JACAFE.address],
      ["a", JACAFE.address],
      ["m", "place"],
      ["rating", "0.800"],
      ["s", "4"],
      ["alt", "Review of Jacafé: 4 of 5 stars"],
      ["price", "2"],
      ["paid", "lightning"],
      ["imeta", `url ${PHOTO}`],
      ["client", "SomeApp"],
    ],
  });

/** The radios of "Price", $ to $$$$; and of "How did you pay?", Lightning, On-chain, Card and Cash. */
const priceRadios = async () => within(await screen.findByRole("radiogroup", { name: copy.review.price })).getAllByRole("radio");
const paidRadios = async () => within(await screen.findByRole("radiogroup", { name: copy.review.howPaid })).getAllByRole("radio");

/** Which of `radios` are checked. */
const checkedOf = (radios: readonly HTMLElement[]) => radios.map((radio) => radio.getAttribute("aria-checked") === "true");

/** The tags of `ev` named `price`, `paid` or `imeta`, in order. */
const pricePaidPhotos = (ev: NostrEvent) => ev.tags.filter(([name]) => name === "price" || name === "paid" || name === "imeta");

/** What the relays said of each try they did not take, kept off the output (src/review/post.ts). */
let warnings: ReturnType<typeof quietPostWarnings>;

beforeEach(() => {
  config.reviewRelays = [SEARCH];
  // The clock stands still at NOW_S: what a review is stamped with is known.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW_S * 1000 });
  warnings = quietPostWarnings();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
});

describe("the review form (the design)", () => {
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
    expect(copy.review.notice).toBe("Reviews are public and carry your name. Posting again replaces your review; you can remove it later.");

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

  it("has a polite line under the words, after the hint, that says nothing and takes no room while there is room", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const line = wordsLine();
    expect(line).toHaveAttribute("aria-live", "polite");
    expect(line).toBeEmptyDOMElement();
    expect(line).toHaveClass("sr-only");
    const hint = screen.getByText(copy.review.textHint);
    expect(hint.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    expect(line).toBeEmptyDOMElement();
  });

  it("takes words up to 1,200 characters, opens a longer review whole, and says so under the field while they are at the limit", async () => {
    const world = newWorld();
    const me = signedIn(world);
    // Written in another app, with more words than the form takes.
    const long = "Get the bolo. ".repeat(100).slice(0, 1_300);
    world.search.push(reviewBy(me.pubkey, 3, long));
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const text = screen.getByRole("textbox", { name: copy.review.textLabel });
    expect(REVIEW_WORDS_MAX).toBe(1_200);
    expect(text).toHaveAttribute("maxlength", "1200");
    await waitFor(() => expect(text).toHaveValue(long));
    expect(long).toHaveLength(1_300);
    const line = wordsLine();
    expect(line).toHaveTextContent(copy.review.wordsFull);
    expect(copy.review.wordsFull).toBe("Reviews stop at 1,200 characters.");
    // As the hint looks, which is still there above it.
    expect(line).toHaveClass("text-caption", "text-muted");
    expect(line).not.toHaveClass("sr-only");
    expect(screen.getByText(copy.review.textHint)).toBeInTheDocument();

    fireEvent.change(text, { target: { value: long.slice(0, REVIEW_WORDS_MAX - 1) } });
    expect(line).toBeEmptyDOMElement();
    expect(line).toHaveClass("sr-only");
    fireEvent.change(text, { target: { value: long.slice(0, REVIEW_WORDS_MAX) } });
    expect(line).toHaveTextContent(copy.review.wordsFull);
    expect(screen.getByText(copy.review.textHint)).toBeInTheDocument();
  });

  it("posts a longer review written elsewhere as it is, cutting none of its words", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const long = "Get the bolo. ".repeat(100).slice(0, 1_300);
    world.search.push(reviewBy(me.pubkey, 3, long));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await waitFor(() => expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue(long));
    await user.click((await starButtons())[4]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)[0]?.content).toBe(long);
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

describe("a price and how they paid: two choices, both optional", () => {
  it("are two radio groups under the stars, before the words: Price, $ to $$$$ read as Price: 1 of 4 to 4 of 4, and How did you pay?", async () => {
    const world = newWorld();
    const me = signedIn(world);
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    expect(copy.review.price).toBe("Price");
    expect(copy.review.howPaid).toBe("How did you pay?");
    const prices = await priceRadios();
    expect(prices.map((radio) => radio.textContent)).toEqual(["$", "$$", "$$$", "$$$$"]);
    prices.forEach((radio, i) => expect(radio).toHaveAccessibleName(`Price: ${i + 1} of 4`));
    const ways = await paidRadios();
    expect(ways.map((radio) => radio.textContent)).toEqual(["Lightning", "On-chain", "Card", "Cash"]);
    ways.forEach((radio) => expect(radio).toHaveAccessibleName(radio.textContent!));
    expect(checkedOf([...prices, ...ways])).toEqual(Array<boolean>(8).fill(false));
    // 44 px tall, and as wide at the least: what a finger needs.
    for (const radio of [...prices, ...ways]) expect(radio).toHaveClass("h-11", "min-w-touch");

    // Under the stars, before the words.
    const [stars, price, paid, ...more] = screen.getAllByRole("radiogroup");
    expect(more).toEqual([]);
    expect(stars).toHaveAccessibleName(copy.review.howWasIt);
    expect(price).toHaveAccessibleName(copy.review.price);
    expect(paid).toHaveAccessibleName(copy.review.howPaid);
    const words = screen.getByRole("textbox", { name: copy.review.textLabel });
    expect(paid!.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("chooses one with a press, another in its place, and clears it with a press on the one chosen; Post still waits for a star", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    const prices = await priceRadios();
    await user.click(prices[1]!);
    expect(checkedOf(prices)).toEqual([false, true, false, false]);
    await user.click(prices[3]!);
    expect(checkedOf(prices)).toEqual([false, false, false, true]);
    await user.click(prices[3]!);
    expect(checkedOf(prices)).toEqual([false, false, false, false]);

    const ways = await paidRadios();
    await user.click(ways[3]!);
    expect(checkedOf(ways)).toEqual([false, false, false, true]);
    await user.click(ways[3]!);
    expect(checkedOf(ways)).toEqual([false, false, false, false]);

    await user.click(prices[0]!);
    await user.click(ways[0]!);
    expect(postButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(postButton());
    expect(me.addOn.signEvent).not.toHaveBeenCalled();
  });

  it("are each one Tab stop, at the one chosen or the first; the arrow keys, Home and End move to one and choose it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    const prices = await priceRadios();
    const ways = await paidRadios();
    const tabStops = (radios: readonly HTMLElement[]) => radios.map((radio) => radio.tabIndex);
    expect(tabStops(prices)).toEqual([0, -1, -1, -1]);
    expect(tabStops(ways)).toEqual([0, -1, -1, -1]);

    prices[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(prices[1]).toHaveFocus();
    expect(checkedOf(prices)).toEqual([false, true, false, false]);
    expect(tabStops(prices)).toEqual([-1, 0, -1, -1]);
    await user.keyboard("{End}");
    expect(prices[3]).toHaveFocus();
    // Round the ends.
    await user.keyboard("{ArrowDown}");
    expect(prices[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(prices[3]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(prices[0]).toHaveFocus();
    expect(checkedOf(prices)).toEqual([true, false, false, false]);

    // The Tab key goes on to the next group, at its first while none is chosen, and then to the words.
    await user.tab();
    expect(ways[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(ways[3]).toHaveFocus();
    expect(checkedOf(ways)).toEqual([false, false, false, true]);
    await user.tab();
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveFocus();
    await user.tab({ shift: true });
    expect(ways[3]).toHaveFocus();
  });

  it("posts with $$ and Cash chosen: the record gives price 2 and paid cash", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    await user.click((await starButtons())[3]!);
    await user.click((await priceRadios())[1]!);
    await user.click((await paidRadios())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    const [sent] = sentTo(world, SEARCH);
    expect(verifyEvent(sent!)).toBe(true);
    expect(sent).toMatchObject({ ...reviewTemplate(JACAFE, 4, "", NOW_S, undefined, { price: 2, paid: "cash" }), pubkey: me.pubkey });
    expect(pricePaidPhotos(sent!)).toEqual([
      ["price", "2"],
      ["paid", "cash"],
    ]);
  });

  it("keeps both in the draft through a reload: one cleared, one left as the person's review gave it, and one chosen", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await waitFor(async () => expect(checkedOf(await paidRadios())).toEqual([true, false, false, false]));

    // Lightning, as their review gave it, is cleared; the price is left as it is.
    await user.click((await paidRadios())[0]!);
    cleanup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    // Their review is read again, and its price shows; the way they cleared stays cleared.
    await waitFor(async () => expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]));
    expect(checkedOf(await paidRadios())).toEqual([false, false, false, false]);

    await user.click((await priceRadios())[3]!);
    await user.click((await paidRadios())[2]!);
    cleanup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    expect(checkedOf(await priceRadios())).toEqual([false, false, false, true]);
    expect(checkedOf(await paidRadios())).toEqual([false, false, true, false]);
  });

  it("opens a draft kept with a price and a way cleared as it was kept, and reads no draft whose price or way is none the form gives", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const keep = (draft: Record<string, unknown>) =>
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ address: JACAFE.address, pubkey: me.pubkey, stars: 3, text: "Kept", ...draft }));
    const formNow = async () => ({
      prices: checkedOf(await priceRadios()),
      ways: checkedOf(await paidRadios()),
      words: (screen.getByRole("textbox", { name: copy.review.textLabel }) as HTMLTextAreaElement).value,
    });

    keep({ price: 2, paid: null });
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    expect(await formNow()).toEqual({ prices: [false, true, false, false], ways: [false, false, false, false], words: "Kept" });

    for (const bad of [{ price: 5 }, { price: "2" }, { paid: "bitcoin" }]) {
      cleanup();
      keep(bad);
      await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
      await reviewingAs(me.name);
      expect(await formNow(), JSON.stringify(bad)).toEqual({
        prices: [false, false, false, false],
        ways: [false, false, false, false],
        words: "",
      });
    }
  });

  it("sends the same signed review on Try again while the stars, words, price and way are the same, and signs a new one when only one of the two changed", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    await user.click((await starButtons())[3]!);
    await user.click((await priceRadios())[1]!);
    await user.click((await paidRadios())[3]!);
    await user.click(postButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    const first = sentTo(world, SEARCH)[0]!;
    expect(pricePaidPhotos(first)).toEqual([
      ["price", "2"],
      ["paid", "cash"],
    ]);

    // Nothing changed: the same signed review, sent again.
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    await user.click(tryAgainButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    await screen.findByRole("button", { name: copy.review.tryAgain });
    expect(sentTo(world, SEARCH)).toEqual([first]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);

    // Only the price changed: a new review, signed, with the new price.
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    await user.click((await priceRadios())[2]!);
    await user.click(tryAgainButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    await screen.findByRole("button", { name: copy.review.tryAgain });
    const second = sentTo(world, SEARCH)[0]!;
    expect(second.id).not.toBe(first.id);
    expect(pricePaidPhotos(second)).toEqual([
      ["price", "3"],
      ["paid", "cash"],
    ]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(2);

    // Only the way changed: a new one again.
    world.writers[SEARCH] = createMemoryWriter();
    await user.click((await paidRadios())[2]!);
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    const [third] = sentTo(world, SEARCH);
    expect(pricePaidPhotos(third!)).toEqual([
      ["price", "3"],
      ["paid", "card"],
    ]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(3);
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
    expect(await rateLink(world)).toHaveAttribute("href", REVIEW_PATH);
    await user.click(await rateLink(world));
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

  it("says it is saved to the person's account but not to Regulars when only their own relay takes it, and holds nothing (R13)", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    // Regulars refuses it for good (blocked:, not a failure that may pass): it is not tried again.
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked: not on the list" });
    world.writers[OWN] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[4]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Worth it");
    await user.click(postButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.notOnRegulars);
    expect(copy.review.notOnRegulars).toBe("Saved to your account, but not to Regulars yet. Try again.");
    expect(sentTo(world, SEARCH)).toHaveLength(1);
    expect(sentTo(world, OWN)).toHaveLength(1);
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Worth it");
    expect(heldText()).toBeNull();

    // Try again, and the review relay takes it this time: the same review, sent again only where it
    // was not taken, and not signed again.
    const first = sentTo(world, OWN)[0]!;
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)).toEqual([first]);
    expect(sentTo(world, OWN)).toHaveLength(1);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(heldRelays()).toEqual(new Set([OWN, SEARCH]));
  });

  it("says it didn't post when the add-on has not signed it in 60 seconds, keeping what was typed; Try again asks again", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    // The add-on shows its question and nobody answers it.
    me.addOn.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    const stars = await starButtons();
    await user.click(stars[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());
    await waitFor(() => expect(me.addOn.signEvent).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: copy.review.posting })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Get the bolo");
    expect(sentTo(world, SEARCH)).toEqual([]);

    // Try again asks the add-on again, which signs this time.
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(2);
    expect(sentTo(world, SEARCH)).toHaveLength(1);
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

    // The relay takes it the second time: the review signed the first time, sent again.
    const first = sentTo(world, SEARCH)[0]!;
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)).toEqual([first]);
    expect(first).toMatchObject({ content: "Slow tonight" });
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the words",
      async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), ", very"),
      { content: "Slow tonight, very", stars: "2" },
    ],
    [
      "the stars",
      async (user: ReturnType<typeof userEvent.setup>) => user.click((await starButtons())[0]!),
      { content: "Slow tonight", stars: "1" },
    ],
  ])("signs the review again on Try again when %s changed since", async (_, change, expected) => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[1]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Slow tonight");
    await user.click(postButton());
    await screen.findByRole("alert");

    await change(user);
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(2);
    const [sent] = sentTo(world, SEARCH);
    expect(verifyEvent(sent!)).toBe(true);
    expect(sent!.content).toBe(expected.content);
    expect(sent!.tags.find((tag) => tag[0] === "s")?.[1]).toBe(expected.stars);
  });

  it("goes back to the place once the review relay takes it, holding every relay it was sent to, answered or not (R17)", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter();
    let answer!: () => void;
    world.writers[OWN] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    // Back at the place while the person's own relay has not answered: it may still keep the review,
    // so a removal goes there too.
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(heldRelays()).toEqual(new Set([SEARCH, OWN]));
    answer();
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
    const live = postingLine(form);
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(live).toHaveTextContent(copy.review.posting));
    expect(copy.review.posting).toBe("Posting…");
  });

  it("says under Post, politely, that it is still posting once Regulars has not taken it in 8 seconds; the line goes once it is posted", async () => {
    const world = newWorld();
    const me = signedIn(world);
    // Regulars does not answer the first try; the second, which starts beside it at 15 seconds, is taken.
    world.writers[SEARCH] = createMemoryWriter({ answers: [{ silent: true }] });
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    const button = postButton();
    const form = button.closest("form")!;
    await user.click(button);
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    const live = postingLine(form);

    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS / 2));
    expect(live).toHaveTextContent(copy.review.posting);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS / 2));
    expect(live).toHaveTextContent(copy.review.stillPosting);
    expect(copy.review.stillPosting).toBe("Still posting. Regulars is slow to answer right now.");
    expect(live).toHaveAttribute("aria-live", "polite");
    // A line anyone can see, under the button, which still says Posting… and is still off.
    expect(live).not.toHaveClass("sr-only");
    expect(button.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button).toHaveAccessibleName(copy.review.posting);
    expect(button).toHaveAttribute("aria-disabled", "true");

    // The second try is taken: back at the place, and the line went with the form.
    await act(() => vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
    expect(sentTo(world, SEARCH)).toHaveLength(2);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    // The first try was still listening when the second was taken: closed, and not a try Regulars did not take.
    expect(postWarnings(warnings)).toEqual([]);
  });

  it("says nothing of Regulars being slow once it has refused the review for good, while the person's own relay is still trying", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked: not on the list" });
    world.writers[OWN] = createMemoryWriter({ silent: true });
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    const form = postButton().closest("form")!;
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, OWN)).toHaveLength(1));
    const live = postingLine(form);

    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS * 1.5));
    expect(live).toHaveTextContent(copy.review.posting);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
  });

  it("stops saying Regulars is slow once it has refused the review for good after the line showed, while the person's own relay is still trying", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    // Regulars says nothing for 10 seconds, then refuses it for good; the person's own relay never answers.
    world.writers[SEARCH] = createMemoryWriter({ answers: [{ delayMs: 10_000, refuse: "blocked: not on the list" }] });
    world.writers[OWN] = createMemoryWriter({ silent: true });
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    const button = postButton();
    const form = button.closest("form")!;
    await user.click(button);
    await waitFor(() => expect(sentTo(world, OWN)).toHaveLength(1));
    const live = postingLine(form);
    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS));
    expect(live).toHaveTextContent(copy.review.stillPosting);

    // Refused for good at 10 seconds: the line goes at once, though the person's own relay has 5 seconds left.
    await act(() => vi.advanceTimersByTimeAsync(10_000 - SLOW_POST_MS));
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
    expect(live).toHaveTextContent(copy.review.posting);
    expect(button).toHaveAccessibleName(copy.review.posting);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
  });

  it("shows no line left from the last post on Try again: it says Regulars is slow only once it is, again", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ silent: true });
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    const form = postButton().closest("form")!;
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    const live = postingLine(form);
    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS));
    expect(live).toHaveTextContent(copy.review.stillPosting);
    await act(() => vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();

    world.writers[SEARCH] = createMemoryWriter({ silent: true });
    await user.click(tryAgainButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    expect(live).toHaveTextContent(copy.review.posting);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(SLOW_POST_MS));
    expect(live).toHaveTextContent(copy.review.stillPosting);
  });

  it("tries Regulars again with the same patience on Try again, sending the same review", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "error: vespa feed 503" });
    world.writers[OWN] = createMemoryWriter();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    // Three tries, 2 and then 5 seconds apart, and then it is not on Regulars, as before.
    await act(() => vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]! + REVIEW_RELAY_WAITS_MS[1]!));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.notOnRegulars);
    expect(sentTo(world, SEARCH)).toHaveLength(REVIEW_RELAY_TRIES);
    expect(screen.queryByText(copy.review.stillPosting)).not.toBeInTheDocument();

    // Try again: the same review, to Regulars alone, which fails once more and takes the next try.
    const first = sentTo(world, SEARCH)[0]!;
    world.writers[SEARCH] = createMemoryWriter({ answers: [{ refuse: "error: vespa feed 503" }] });
    await user.click(tryAgainButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]!));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)).toEqual([first, first]);
    expect(sentTo(world, OWN)).toEqual([first]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("stops trying Regulars again when the person leaves the form before it is posted, and holds nothing", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter({ refuse: "error: vespa feed 503" });
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));

    // While it waits to try again, the person goes back to the place.
    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    await act(() => vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS));
    expect(sentTo(world, SEARCH)).toHaveLength(1);
    expect(heldText()).toBeNull();
  });

  it("stamps an edit made in the same second one second after the review it replaces, so it replaces it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    await user.click(await rateLink(world));
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    // Again, in the same second, by Edit under it: the form has the review just posted, and the edit
    // is stamped after it.
    await user.click(within(await screen.findByRole("region", { name: copy.reviews.yours })).getByRole("link", { name: copy.reviews.edit }));
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    await user.click(stars[4]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    expect(sentTo(world, SEARCH).map((ev) => ev.created_at)).toEqual([NOW_S, NOW_S + 1]);
    expect(sentTo(world, SEARCH).map((ev) => ev.tags.find((tag) => tag[0] === "s")?.[1])).toEqual(["4", "5"]);
  });
});

describe("editing a review written in another app", () => {
  /**
   * The search relay of `world`, holding back each request that `held` picks until the test lets it
   * go (`release`); `waiting` says how many it holds. Every other request is answered at once.
   */
  function holdingBack(world: ReturnType<typeof newWorld>, held: (filter: NostrFilter) => boolean) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const readers = (url: string): RelayReader => {
      const reader = readersOf(world)(url);
      if (url !== SEARCH) return reader;
      return {
        async *req(filter, signal, opts) {
          if (held(filter)) {
            waiting += 1;
            await new Promise<void>((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              void released.then(resolve);
            });
          }
          yield* reader.req(filter, signal, opts);
        },
      };
    };
    return {
      readers,
      release: () => act(() => release()),
      get waiting() {
        return waiting;
      },
    };
  }
  /** The place's reviews, read by its address or its `d`: not a person's page, nor Trending. */
  const placeReviews = (filter: NostrFilter) => filter.kinds?.includes(REVIEW_KIND) === true && (filter["#a"] !== undefined || filter["#d"] !== undefined);
  const removals = (filter: NostrFilter) => filter.kinds?.includes(5) === true;
  /** Lets what is queued run, for a check that something has not happened. */
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

  it("shows the words without the photo's address, and an edit keeps the price, payment and photo, its d, and is dated after it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    // Written on a device whose clock runs an hour ahead.
    const theirs = writtenElsewhere(me.pubkey, NOW_S + 3_600);
    world.search.push(theirs);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    expect(await reviewWords(WORDS)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PHOTO);
    await user.click(within(await screen.findByRole("region", { name: copy.reviews.yours })).getByRole("link", { name: copy.reviews.edit }));
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue(WORDS);

    await user.click(stars[4]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    const [sent] = sentTo(world, SEARCH);
    expect(verifyEvent(sent!)).toBe(true);
    expect(sent!.tags).toEqual([
      ["d", JACAFE.address],
      ["a", JACAFE.address, "wss://dcosl.brainstorm.world"],
      ["m", "place"],
      ["rating", "1.000"],
      ["s", "5"],
      ["alt", "Review of Jacafé: 5 of 5 stars"],
      ["price", "2"],
      ["paid", "lightning"],
      ["imeta", `url ${PHOTO}`],
    ]);
    expect(sent!.content).toBe(`${WORDS}\n${PHOTO}`);
    expect(sent!.created_at).toBe(theirs.created_at + 1);
    // The place shows the edit in its place, still without the address.
    expect(await reviewWords(WORDS)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PHOTO);
  });

  it("opens with the price and the way of the person's review chosen; an edit of the stars alone keeps both, and the photo", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]);
    expect(checkedOf(await paidRadios())).toEqual([true, false, false, false]);
    expect((await priceRadios()).map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);

    await user.click(stars[4]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    const [sent] = sentTo(world, SEARCH);
    expect(pricePaidPhotos(sent!)).toEqual([
      ["price", "2"],
      ["paid", "lightning"],
      ["imeta", `url ${PHOTO}`],
    ]);
    expect(sent!.content).toBe(`${WORDS}\n${PHOTO}`);
  });

  it("signs no price once the person clears the review's $$, and keeps the way and the photo", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await waitFor(async () => expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]));
    await user.click((await priceRadios())[1]!);
    expect(checkedOf(await priceRadios())).toEqual([false, false, false, false]);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    const [sent] = sentTo(world, SEARCH);
    expect(pricePaidPhotos(sent!)).toEqual([
      ["paid", "lightning"],
      ["imeta", `url ${PHOTO}`],
    ]);
    expect(sent!.content).toBe(`${WORDS}\n${PHOTO}`);
  });

  describe("posted before the place's reviews, and their removals, are read", () => {
    it("signs nothing until the person's review is read, then builds on it: its price, payment and photo, its d", async () => {
      const world = newWorld();
      const me = signedIn(world);
      world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, placeReviews);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(() => expect(search.waiting).toBe(2));
      await user.click((await starButtons())[4]!);
      await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Better than last time");
      await user.click(postButton());
      expect(screen.getByRole("button", { name: copy.review.posting })).toBeInTheDocument();
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();
      expect(sentTo(world, SEARCH)).toEqual([]);

      await search.release();
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(sent!.tags).toEqual([
        ["d", JACAFE.address],
        ["a", JACAFE.address, "wss://dcosl.brainstorm.world"],
        ["m", "place"],
        ["rating", "1.000"],
        ["s", "5"],
        ["alt", "Review of Jacafé: 5 of 5 stars"],
        ["price", "2"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ]);
      expect(sent!.content).toBe(`Better than last time\n${PHOTO}`);
      expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    });

    it("keeps the review's price and way when the person typed before it was read, touched neither, and posts once it is", async () => {
      const world = newWorld();
      const me = signedIn(world);
      world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, placeReviews);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(() => expect(search.waiting).toBe(2));
      expect(checkedOf([...(await priceRadios()), ...(await paidRadios())])).toEqual(Array<boolean>(8).fill(false));
      await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Better than last time");

      // Their review is read: the words typed stay, and its price and way show, chosen as it gave them.
      await search.release();
      await waitFor(async () => expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]));
      expect(checkedOf(await paidRadios())).toEqual([true, false, false, false]);
      expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Better than last time");

      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(pricePaidPhotos(sent!)).toEqual([
        ["price", "2"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ]);
      expect(sent!.content).toBe(`Better than last time\n${PHOTO}`);
    });

    it("keeps the review's price and way when the person posted before it was read, touching neither", async () => {
      const world = newWorld();
      const me = signedIn(world);
      world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, placeReviews);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(() => expect(search.waiting).toBe(2));
      expect(checkedOf([...(await priceRadios()), ...(await paidRadios())])).toEqual(Array<boolean>(8).fill(false));
      await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Better than last time");
      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();

      await search.release();
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(pricePaidPhotos(sent!)).toEqual([
        ["price", "2"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ]);
    });

    it("dates the edit a second after the person's removal, dated an hour ahead, once that removal is read", async () => {
      const world = newWorld();
      const me = signedIn(world);
      const theirs = writtenElsewhere(me.pubkey, NOW_S - 86_400);
      // Removed on a device whose clock runs an hour ahead.
      const removal = shapedEvent({ kind: 5, pubkey: me.pubkey, created_at: NOW_S + 3_600, tags: [["e", theirs.id], ["a", `${REVIEW_KIND}:${me.pubkey}:${JACAFE.address}`], ["k", String(REVIEW_KIND)]] });
      world.search.push(theirs, removal);
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, removals);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(() => expect(search.waiting).toBe(2));
      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();

      await search.release();
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(sent!.created_at).toBe(NOW_S + 3_601);
      // The review it would have been built on is taken down: it is built on nothing, at the place's own d.
      expect(sent!.tags.find((tag) => tag[0] === "d")).toEqual(["d", `place:${JACAFE.address}`]);
      expect(sent!.tags.some((tag) => tag[0] === "price")).toBe(false);
    });

    it("says it didn't post, and signs nothing, when the review whose stars it showed is taken down by a removal read while it waited", async () => {
      const world = newWorld();
      const me = signedIn(world);
      const theirs = writtenElsewhere(me.pubkey, NOW_S - 86_400);
      const removal = shapedEvent({ kind: 5, pubkey: me.pubkey, created_at: NOW_S - 3_600, tags: [["e", theirs.id], ["k", String(REVIEW_KIND)]] });
      world.search.push(theirs, removal);
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, removals);
      const user = userEvent.setup();
      await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(async () => expect((await starButtons())[3]).toHaveAttribute("aria-checked", "true"));
      await waitFor(() => expect(search.waiting).toBeGreaterThan(0));
      // Posted with the stars their review gives, untouched.
      await user.click(postButton());
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();

      await search.release();
      expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
      expect(me.addOn.signEvent).not.toHaveBeenCalled();
      expect(sentTo(world, SEARCH)).toEqual([]);
      // Their review is gone: no stars are shown, and Try again waits for some.
      expect(checkedOf(await starButtons())).toEqual([false, false, false, false, false]);
      expect(tryAgainButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("signs nothing when the form is closed while it waits", async () => {
      const world = newWorld();
      const me = signedIn(world);
      world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, placeReviews);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await reviewingAs(me.name);
      await waitFor(() => expect(search.waiting).toBe(2));
      await user.click((await starButtons())[3]!);
      await user.click(postButton());
      await settle();

      await user.click(screen.getByRole("link", { name: copy.review.back }));
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      await search.release();
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();
      expect(sentTo(world, SEARCH)).toEqual([]);
      expect(heldText()).toBeNull();
    });
  });

  it("sends the same signed edit again on Try again when nothing in the form changed, its photo after the words", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    await user.click(postButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    const first = sentTo(world, SEARCH)[0]!;
    expect(first.content).toBe(`${WORDS}\n${PHOTO}`);

    world.writers[SEARCH] = createMemoryWriter();
    await user.click(tryAgainButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)).toEqual([first]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  describe("a field pressed or typed into before the person's review is read: the others are still filled from it, and kept", () => {
    /** The person, whose review of Jacafé (4 stars, `WORDS`, $$, Lightning, `PHOTO`) the search relay holds. */
    function personWithReview() {
      const world = newWorld();
      const me = signedIn(world);
      world.search.push(writtenElsewhere(me.pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      return { world, me };
    }
    /** The form, opened while the relay holds back the place's reviews until `release`. */
    async function openHeld(world: ReturnType<typeof newWorld>, name: string) {
      const search = holdingBack(world, placeReviews);
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });
      await reviewingAs(name);
      await waitFor(() => expect(search.waiting).toBe(2));
      return { search, router };
    }
    const words = () => screen.getByRole("textbox", { name: copy.review.textLabel });
    /** That `sent` is the person's review with `stars`, its words and photo after them, its price, way and photo kept. */
    const expectKept = (sent: NostrEvent | undefined, stars: number) => {
      expect(sent!.content).toBe(`${WORDS}\n${PHOTO}`);
      expect(sent!.tags.find(([name]) => name === "s")).toEqual(["s", String(stars)]);
      expect(pricePaidPhotos(sent!)).toEqual([
        ["price", "2"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ]);
    };

    it("fills the words in once the review is read after a star was pressed, and posts them with the photo, the price and the way", async () => {
      const { world, me } = personWithReview();
      const user = userEvent.setup();
      const { search, router } = await openHeld(world, me.name);

      await user.click((await starButtons())[4]!);
      expect(words()).toHaveValue("");
      await search.release();
      await waitFor(() => expect(words()).toHaveValue(WORDS));
      expect((await starButtons())[4]).toHaveAttribute("aria-checked", "true");

      await user.click(postButton());
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      expectKept(sentTo(world, SEARCH)[0], 5);
    });

    it("posts the review's words, photo, price and way when a star and Post were both pressed before it was read", async () => {
      const { world, me } = personWithReview();
      const user = userEvent.setup();
      const { search, router } = await openHeld(world, me.name);

      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await settle();
      expect(me.addOn.signEvent).not.toHaveBeenCalled();

      await search.release();
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      expectKept(sentTo(world, SEARCH)[0], 5);
    });

    it("fills the stars and the words in once the review is read after a price was pressed: the price pressed stays, and Lightning shows", async () => {
      const { world, me } = personWithReview();
      const user = userEvent.setup();
      const { search, router } = await openHeld(world, me.name);

      await user.click((await priceRadios())[2]!);
      await search.release();
      await waitFor(async () => expect((await starButtons())[3]).toHaveAttribute("aria-checked", "true"));
      expect(words()).toHaveValue(WORDS);
      expect(checkedOf(await priceRadios())).toEqual([false, false, true, false]);
      expect(checkedOf(await paidRadios())).toEqual([true, false, false, false]);

      await user.click(postButton());
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(sent!.content).toBe(`${WORDS}\n${PHOTO}`);
      expect(sent!.tags.find(([name]) => name === "s")).toEqual(["s", "4"]);
      expect(pricePaidPhotos(sent!)).toEqual([
        ["price", "3"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ]);
    });

    it("fills the words in after a reload, when only a star was pressed before it", async () => {
      const { world, me } = personWithReview();
      const user = userEvent.setup();
      await openHeld(world, me.name);
      await user.click((await starButtons())[4]!);

      cleanup();
      const { search } = await openHeld(world, me.name);
      expect((await starButtons())[4]).toHaveAttribute("aria-checked", "true");
      expect(words()).toHaveValue("");
      await search.release();
      await waitFor(() => expect(words()).toHaveValue(WORDS));
      expect((await starButtons())[4]).toHaveAttribute("aria-checked", "true");
      expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]);
    });

    it("keeps the review's words through a trip to sign in from a form opened signed out, a star pressed and Post", async () => {
      const world = newWorld();
      const key = generateSecretKey();
      const pubkey = getPublicKey(key);
      installAddOn(key);
      world.search.push(profileOf(pubkey, "Maya"), writtenElsewhere(pubkey, NOW_S - 86_400));
      world.writers[SEARCH] = createMemoryWriter();
      const search = holdingBack(world, placeReviews);
      const user = userEvent.setup();
      const { router } = await openApp(REVIEW_PATH, { events: places, entries: fromExplore(PLACE_PATH, REVIEW_PATH), readers: search.readers, writers: writersOf(world) });

      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
      await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
      await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
      expect((await starButtons())[4]).toHaveAttribute("aria-checked", "true");

      await search.release();
      await waitFor(() => expect(words()).toHaveValue(WORDS));
      await user.click(postButton());
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [sent] = sentTo(world, SEARCH);
      expect(sent!.pubkey).toBe(pubkey);
      expectKept(sent, 5);
    });

    it("reads a draft kept in the shape every earlier one has, its words as typed and no star as none chosen", async () => {
      const { world, me } = personWithReview();
      for (const typed of ["Kept", ""]) {
        cleanup();
        window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ address: JACAFE.address, pubkey: me.pubkey, stars: null, text: typed }));
        await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
        await reviewingAs(me.name);
        // Their review is read: its stars fill in, and the words kept stay as they were typed.
        await waitFor(async () => expect((await starButtons())[3]).toHaveAttribute("aria-checked", "true"));
        expect(words()).toHaveValue(typed);
      }
    });

    it("carries the words, the price, the way and the photo into the new review Try again signs when only the stars changed", async () => {
      const { world, me } = personWithReview();
      world.writers[SEARCH] = createMemoryWriter({ refuse: "blocked" });
      const user = userEvent.setup();
      const { search, router } = await openHeld(world, me.name);

      await user.click((await starButtons())[4]!);
      await user.click(postButton());
      await search.release();
      expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
      const first = sentTo(world, SEARCH)[0]!;
      expectKept(first, 5);

      world.writers[SEARCH] = createMemoryWriter();
      await user.click((await starButtons())[2]!);
      await user.click(tryAgainButton());
      await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
      const [second] = sentTo(world, SEARCH);
      expect(second!.id).not.toBe(first.id);
      expectKept(second, 3);
      expect(me.addOn.signEvent).toHaveBeenCalledTimes(2);
    });
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

    // So once the relay drops it, it is gone. (A page just opened says "Be the first" until it asks for
    // its reviews: what it says once they are read is what counts.)
    world.search.splice(world.search.indexOf(sentTo(world, SEARCH)[0]!), 1);
    cleanup();
    const reads = world.reviewReads;
    await open(world, [PLACE_PATH]);
    await waitFor(() => expect(world.reviewReads).toBeGreaterThan(reads));
    expect(await screen.findByText(copy.place.beFirst)).toBeInTheDocument();
    expect(noReviewWords("Get the bolo")).not.toBeInTheDocument();
  });
});

describe("signing in to rate", () => {
  it("signs a person who is signed out in at once with their add-on from Rate this place, and opens the form: no sign-in page", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    const addOn = installAddOn(key);
    world.search.push(profileOf(getPublicKey(key), "Maya"));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    const visited: string[] = [];
    router.subscribe((state) => visited.push(state.location.pathname));

    // Its address is still sign in's, for a new tab, which has no add-on's answer to go on.
    const rate = await rateLink(world);
    expect(rate).toHaveAttribute("href", "/signin");
    await user.click(rate);
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect(visited).not.toContain("/signin");
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(1);
    expect(readSession()).toEqual({ how: "browser", pubkey: getPublicKey(key) });
    expect(await reviewingAs("Maya")).toBeInTheDocument();

    // The way back from the form is the place, one step back.
    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
  });

  it("opens the form as a dialog over the place on a desktop, once the add-on has said who the person is", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    installAddOn(key);
    world.search.push(profileOf(getPublicKey(key), "Maya"));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);
    await user.click(await rateLink(world));

    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await reviewingAs("Maya", within(dialog));
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(screen.getByRole("complementary", { name: copy.place.railLabel })).toBeInTheDocument();
  });

  it("says it didn't work on the place's page when the add-on says no, and Try again opens the form", async () => {
    const world = newWorld();
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockRejectedValueOnce(new Error("The person said no"));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    await user.click(await rateLink(world));

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signin.addOnFailed);
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(readSession()).toBeNull();
    const retry = screen.getByRole("button", { name: copy.signin.tryAgain });
    expect(retry).toHaveFocus();
    expect(screen.getByRole("link", { name: copy.signin.phoneInstead })).toHaveAttribute("href", "/signin");

    await user.click(retry);
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(2);
    // The way back from the form is the place, one step back (once the form is drawn).
    await user.click(await screen.findByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
  });

  it("opens sign in at the phone's way from there, and then the form", async () => {
    const world = newWorld();
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockRejectedValueOnce(new Error("The add-on is locked"));
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    world.search.push(profileOf(app.userPubkey, "Alice"));
    const user = userEvent.setup();
    const { router } = await openApp(PLACE_PATH, {
      events: places,
      entries: fromExplore(PLACE_PATH),
      readers: readersOf(world),
      writers: writersOf(world),
      relays: () => relay,
    });
    await user.click(await rateLink(world));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("link", { name: copy.signin.phoneInstead }));

    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: PLACE_PATH }, next: { pathname: REVIEW_PATH }, phone: true });
    // No Continue to press: the code is there.
    await screen.findByRole("img", { name: copy.signin.qrLabel });
    expect(screen.queryByRole("button", { name: copy.signin.continueButton })).not.toBeInTheDocument();
    await app.scan(screen.getByRole("link", { name: copy.signin.openApp }).getAttribute("href")!);
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(await reviewingAs("Alice")).toBeInTheDocument();
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it("stops saying the add-on didn't work at Dismiss, and gives the focus back to Rate this place", async () => {
    const world = newWorld();
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockRejectedValueOnce(new Error("The person said no"));
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));
    const rate = await rateLink(world);
    await user.click(rate);
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: copy.signin.dismiss }));
    expect(screen.queryByText(copy.signin.addOnFailed)).not.toBeInTheDocument();
    expect(rate).toHaveFocus();
  });

  it("asks the add-on once when Rate this place and the account button are both pressed: one prompt, and the form", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    const addOn = installAddOn(key);
    let answer!: () => void;
    addOn.getPublicKey.mockImplementationOnce(() => new Promise<string>((resolve) => (answer = () => resolve(getPublicKey(key)))));
    world.search.push(profileOf(getPublicKey(key), "Maya"));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);
    await user.click(await rateLink(world));
    await user.click(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.signIn }));
    await waitFor(() => expect(addOn.getPublicKey).toHaveBeenCalledTimes(1));

    act(() => answer());
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await reviewingAs("Maya", within(dialog));
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says it is waiting while the add-on asks, with Rate this place busy, and Cancel stops waiting", async () => {
    const world = newWorld();
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockImplementationOnce(() => new Promise<string>(() => {}));
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    const rate = await rateLink(world);
    await user.click(rate);

    const waiting = await screen.findByText(copy.signin.waitingForAddOn);
    expect(waiting).toHaveAttribute("role", "status");
    expect(waiting).toHaveAttribute("aria-live", "polite");
    expect(rate).toHaveAttribute("aria-busy", "true");
    // Pressed again while it asks, it does nothing.
    await user.click(rate);
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe(PLACE_PATH);

    await user.click(screen.getByRole("button", { name: copy.signin.cancel }));
    expect(screen.queryByText(copy.signin.waitingForAddOn)).not.toBeInTheDocument();
    expect(rate).not.toHaveAttribute("aria-busy");
    expect(rate).toHaveFocus();
    expect(readSession()).toBeNull();
    expect(router.state.location.pathname).toBe(PLACE_PATH);
  });

  it("gives up on the add-on after a minute with no answer, and says it didn't work, on the place's page", async () => {
    const world = newWorld();
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockImplementationOnce(() => new Promise<string>(() => {}));
    const { router } = await open(world, fromExplore(PLACE_PATH));
    const rate = await rateLink(world);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: NOW_S * 1000 });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(rate);
    await waitFor(() => expect(addOn.getPublicKey).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(ADD_ON_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signin.addOnFailed);
    expect(screen.queryByText(copy.signin.waitingForAddOn)).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PLACE_PATH);
  });

  it("takes a person with no add-on from Rate this place to sign in, the phone's way at once, and then to the form", async () => {
    const world = newWorld();
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    world.search.push(profileOf(app.userPubkey, "Alice"));
    const user = userEvent.setup();
    const { router } = await openApp(PLACE_PATH, {
      events: places,
      entries: fromExplore(PLACE_PATH),
      readers: readersOf(world),
      writers: writersOf(world),
      relays: () => relay,
    });

    const rate = await rateLink(world);
    expect(rate).toHaveAttribute("href", "/signin");
    await user.click(rate);
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: PLACE_PATH }, next: { pathname: REVIEW_PATH } });

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });
    await app.scan(screen.getByRole("link", { name: copy.signin.openApp }).getAttribute("href")!);
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(await reviewingAs("Alice")).toBeInTheDocument();

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
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
  });

  it("opens the form in place of sign in when sign in was the first page opened, with the place as its way back", async () => {
    const world = newWorld();
    installAddOn(generateSecretKey());
    const user = userEvent.setup();
    const place = { pathname: PLACE_PATH, search: "", hash: "" };
    const { router } = await open(world, [{ pathname: "/signin", state: { from: place, next: { pathname: REVIEW_PATH } } }]);

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    // Nothing is behind it in the history: its way back puts the place in its stead.
    await user.click(await screen.findByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("goes back to the place, not to sign in, when the person keeps House picks", async () => {
    const world = newWorld();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    await user.click(await rateLink(world));
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
    await user.click(await rateLink(world));
    const stars = await starButtons();
    await user.click(stars[1]!);
    const text = screen.getByRole("textbox", { name: copy.review.textLabel });
    await user.clear(text);
    await user.type(text, "Changed my mind");
    await user.click(postButton());

    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
    expect(heldText()).toBeNull();
    await user.click(await screen.findByRole("button", { name: copy.signin.continueButton }));
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
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    expect((await starButtons())[2]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("Fine coffee");
  });
});

describe("on a desktop: a dialog over the place page (the design)", () => {
  it("keeps the focus inside while it is open, and gives it back to Rate this place when Escape closes it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    const rate = await rateLink(world);
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
    expect(await rateLink(world)).toHaveFocus();
  });

  it("closes with its cross, and after posting, back to the place page with the review on it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    await user.click(await rateLink(world));
    await user.click(await screen.findByRole("button", { name: copy.review.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await rateLink(world)).toHaveFocus();

    await user.click(await rateLink(world));
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
    await user.click(await rateLink(world));
    await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    const stars = await starButtons();
    expect(stars[2]).toHaveAttribute("aria-checked", "true");
    expect(stars[2]).toHaveFocus();
  });

  it("starts the focus at the first star, not at the price chosen, when the person's review gives a price and no stars", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(
      shapedEvent({
        kind: REVIEW_KIND,
        pubkey: me.pubkey,
        created_at: NOW_S - 86_400,
        content: "Bolo do caco",
        tags: [["d", `place:${JACAFE.address}`], ["a", JACAFE.address], ["m", "place"], ["price", "2"]],
      }),
    );
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH), DESKTOP);

    expect(await reviewWords("Bolo do caco")).toBeInTheDocument();
    await user.click(await rateLink(world));
    await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    expect(checkedOf(await priceRadios())).toEqual([false, true, false, false]);
    const stars = await starButtons();
    expect(checkedOf(stars)).toEqual([false, false, false, false, false]);
    expect(stars[0]).toHaveFocus();
  });

  it("closes once when Escape is pressed twice before the page has redrawn (R15)", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    await user.click(await rateLink(world));
    await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(PLACE_PATH);
  });

  it("stops posting when it is closed while the review is being sent, and holds nothing", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const silent = createMemoryWriter({ silent: true });
    world.writers[SEARCH] = silent;
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), DESKTOP);

    await user.click(await rateLink(world));
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

describe("on a phone: a page of its own (the design)", () => {
  it("is at /place/:d/review in place of the place's page, with a back arrow to the place", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    await user.click(await rateLink(world));
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

  it("goes back once when its back arrow is pressed twice before the page has left (R15)", async () => {
    const world = newWorld();
    signedIn(world);
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    await user.click(await rateLink(world));
    const back = await screen.findByRole("link", { name: copy.review.back });
    const history = backLikeABrowser(router);

    await act(async () => {
      fireEvent.click(back);
      fireEvent.click(back);
    });
    expect(history.held).toBe(1);
    await history.land();
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(router.state.historyAction).toBe("POP");
  });

  it("goes back once when the review is posted while the person is already going back (R15)", async () => {
    const world = newWorld();
    const me = signedIn(world);
    let answer!: () => void;
    world.writers[SEARCH] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));
    await user.click(await rateLink(world));
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));
    const history = backLikeABrowser(router);

    // Back, and the review relay takes the review before the page has left the form: it is posted
    // (held for the tab), and that asks for no second step back.
    fireEvent.click(screen.getByRole("link", { name: copy.review.back }));
    expect(history.held).toBe(1);
    answer();
    await waitFor(() => expect(heldText()).not.toBeNull());
    expect(history.held).toBe(1);
    await history.land();
    expect(router.state.location.pathname).toBe(PLACE_PATH);
    expect(router.state.historyAction).toBe("POP");
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

describe("crossing 900 px: the form drawn the other way (a phone turned, a window resized)", () => {
  /** The form's stars, which are checked, and its words. */
  const formNow = async () => ({
    checked: (await starButtons()).map((star) => star.getAttribute("aria-checked") === "true"),
    words: (screen.getByRole("textbox", { name: copy.review.textLabel }) as HTMLTextAreaElement).value,
  });
  const fourStars = [false, false, false, true, false];

  it("keeps the stars and the words typed, from a phone's page to a desktop's dialog and back", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);

    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");

    act(() => resizeTo(DESKTOP));
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await waitFor(async () => expect(await formNow()).toEqual({ checked: fourStars, words: "Get the bolo" }));
    expect(dialog).toContainElement(screen.getByRole("textbox", { name: copy.review.textLabel }));

    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), ", and sit outside");
    act(() => resizeTo(PHONE));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(async () => expect(await formNow()).toEqual({ checked: fourStars, words: "Get the bolo, and sit outside" }));
  });

  it("finishes a post under way when the window crosses 900 px, says so on the form drawn again, and posts it once", async () => {
    const world = newWorld();
    const me = signedIn(world);
    let answer!: () => void;
    world.writers[SEARCH] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));

    act(() => resizeTo(DESKTOP));
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    // Still posting, on the form drawn again: the post was not dropped, nor started again.
    expect(within(dialog).getByRole("button", { name: copy.review.posting })).toHaveAttribute("aria-disabled", "true");
    expect(world.writers[SEARCH]!.signals[0]!.aborted).toBe(false);

    act(() => answer());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(sentTo(world, SEARCH)).toHaveLength(1);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
  });

  it("shows on the form drawn again that a post failed, with what was typed, and Try again", async () => {
    const world = newWorld();
    const me = signedIn(world);
    let refuse!: () => void;
    const refused = new Promise<void>((_, reject) => (refuse = () => reject(new Error("blocked"))));
    refused.catch(() => {});
    world.writers[SEARCH] = createMemoryWriter({ until: refused });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH), DESKTOP);
    const dialog = await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    await reviewingAs(me.name, within(dialog));
    await user.click((await starButtons())[1]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Slow tonight");
    await user.click(within(dialog).getByRole("button", { name: copy.review.post }));
    await waitFor(() => expect(sentTo(world, SEARCH)).toHaveLength(1));

    act(() => resizeTo(PHONE));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => refuse());
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.review.failed);
    expect(tryAgainButton()).toBeInTheDocument();
    expect(await formNow()).toEqual({ checked: [false, true, false, false, false], words: "Slow tonight" });
  });

  it("keeps the draft in this tab for the place and the person: a reload has it, posting or closing forgets it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await user.click((await starButtons())[2]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Fine");

    // Reloaded: the draft is there.
    cleanup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    expect(await formNow()).toEqual({ checked: [false, false, true, false, false], words: "Fine" });

    // Closed by its back arrow: forgotten.
    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: copy.review.howWasIt })).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    cleanup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    expect(await formNow()).toEqual({ checked: [false, false, false, false, false], words: "" });

    // Posted: forgotten.
    await user.click((await starButtons())[4]!);
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await user.click(postButton());
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: copy.review.howWasIt })).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("never gives one person's draft to another signed in after them in the tab", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    await user.click((await starButtons())[0]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Mine alone");
    cleanup();

    // Someone else signs in in this tab, and opens the form for the same place.
    window.sessionStorage.removeItem(SESSION_KEY);
    const other = signedIn(world, { name: "Sofia" });
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(other.name);
    expect(await formNow()).toEqual({ checked: [false, false, false, false, false], words: "" });
  });
});
