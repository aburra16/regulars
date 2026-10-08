import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADD_ON_TIMEOUT_MS } from "../src/account/connect";
import { readSession, SESSION_KEY } from "../src/account/session";
import { DRAFT_KEY } from "../src/review/draft";
import { SIGN_TIMEOUT_MS } from "../src/review/post";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { reviewTemplate } from "../src/reviews/write";
import { DESKTOP, openApp, PHONE, resetWidth, resizeTo } from "./support/app";
import { createSignerApp, MemoryConnectRelay } from "./support/connectRelay";
import { createMemoryWriter } from "./support/memoryWriter";
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
    expect(copy.review.notice).toBe(
      "Reviews are public and carry your name. One review per place: posting again replaces this one. You can remove it later.",
    );

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
    // The way back from the form is the place, one step back.
    await user.click(screen.getByRole("link", { name: copy.review.back }));
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

describe("on a desktop: a dialog over the place page (DeskReview.dc.html)", () => {
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

describe("on a phone: a page of its own (Review.dc.html)", () => {
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
    await waitFor(() => expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    cleanup();
    await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));
    await reviewingAs(me.name);
    expect(await formNow()).toEqual({ checked: [false, false, false, false, false], words: "" });

    // Posted: forgotten.
    await user.click((await starButtons())[4]!);
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await user.click(postButton());
    await waitFor(() => expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument());
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
