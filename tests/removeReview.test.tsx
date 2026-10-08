import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSession, SESSION_KEY } from "../src/account/session";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { distanceKm } from "../src/places/distance";
import { buildIndexes, chainSlug } from "../src/places/indexes";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { REVIEW_KIND } from "../src/reviews/review";
import { removalTemplate, reviewTemplate } from "../src/reviews/write";
import { HELD_REVIEWS_KEY } from "../src/score/store";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { shapedEvent } from "./support/events";
import { createMemoryWriter } from "./support/memoryWriter";
import {
  ANOTHER,
  fromExplore,
  heldText,
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
  rankOf,
  rateLink,
  readersOf,
  REVIEW_PATH,
  reviewBy,
  reviewingAs,
  reviewOfPlace,
  reviewWords,
  SEARCH,
  sentTo,
  signedIn,
  starButtons,
  type World,
  writersOf,
} from "./support/reviewWorld";

/*
 * Removing a review (M2b Task 7; ruling R15): the person's own review on its own at the top of the
 * place's reviews, with Edit and Remove; asking first; one removal (NIP-09) of every version of it,
 * sent where it went; hidden at once, and kept hidden from a relay that lags (Review Focus 2); and
 * rating the place again after. With R15's carried fixes: the panel says "You've rated it", no
 * "Be the first" for a frame, and held reviews let go of when a session can't be restored. Relays
 * are held in memory; nothing opens a socket.
 */

// Restoring a kept session can fail (the signing code can't start): `restore.broken` makes it, until
// a test mends it.
const restore = vi.hoisted(() => ({ broken: false }));
vi.mock("../src/account/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/account/connect")>();
  return {
    ...actual,
    restoreAccount: (...args: Parameters<typeof actual.restoreAccount>) => {
      if (restore.broken) throw new Error("The signing code could not start");
      return actual.restoreAccount(...args);
    },
  };
});

// A session this tab kept, being restored for as long as a test likes: `account.restoring` holds every
// page's `useAccount` there (signed out, about to be signed in) until a test lets go.
const account = vi.hoisted(() => ({ restoring: false }));
vi.mock("../src/account/AccountProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/account/AccountProvider")>();
  return {
    ...actual,
    useAccount: () => (account.restoring ? { account: undefined, restoring: true, signOut: () => {} } : actual.useAccount()),
  };
});

/** The "Your review" section, once the place's page shows it. */
const yourReview = () => screen.findByRole("region", { name: copy.reviews.yours });
const noYourReview = () => screen.queryByRole("region", { name: copy.reviews.yours });

/** Remove, in the person's own review, once it is on: once the session this tab kept is restored. */
async function removeButton(mine: HTMLElement) {
  const remove = within(mine).getByRole("button", { name: copy.reviews.remove });
  await waitFor(() => expect(remove).not.toHaveAttribute("aria-disabled"));
  return remove;
}

/** Remove, then Remove again to confirm, inside the person's own review. */
async function removeIt(user: ReturnType<typeof userEvent.setup>) {
  const mine = await yourReview();
  await user.click(await removeButton(mine));
  await user.click(within(mine).getByRole("button", { name: copy.reviews.removeConfirm }));
}

/** The lines of the panel whose heading is "No score yet", in order. */
const noScoreLines = async () => {
  const title = await screen.findByRole("heading", { level: 2, name: copy.score.noScoreYet });
  return [...title.closest("section")!.querySelectorAll("p")].map((line) => line.textContent);
};

/** A reader that is asked for reviews and never answers, until its request is stopped. */
const neverAnswers: RelayReader = {
  // eslint-disable-next-line require-yield -- it never has anything to give
  async *req(_filter, signal) {
    await new Promise<never>((_, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  },
};

/** The world's readers, but the search relay never answers. */
const searchNeverAnswers = (world: World) => (url: string) => (url === SEARCH ? neverAnswers : readersOf(world)(url));

/**
 * Watches the page for `text` coming onto it, even for a moment: what each change added, as it was
 * added. `seen()` says whether it ever did.
 */
function watchFor(text: string) {
  let ever = false;
  const look = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "characterData" && record.target.textContent?.includes(text)) ever = true;
      for (const node of record.addedNodes) if (node.textContent?.includes(text)) ever = true;
    }
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    seen() {
      look(observer.takeRecords());
      return ever;
    },
    stop: () => observer.disconnect(),
  };
}

beforeEach(() => {
  config.reviewRelays = [SEARCH];
  // The clock stands still at NOW_S: what a removal and a review are stamped with is known.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW_S * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  restore.broken = false;
  account.restoring = false;
  Reflect.deleteProperty(window, "nostr");
});

describe("removing a review", () => {
  it("asks first; Keep it leaves the review as it was, and a double click asks without removing", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    const mine = await yourReview();
    expect(within(mine).getByText("Get the bolo")).toBeInTheDocument();
    await user.click(await removeButton(mine));

    expect(within(mine).getByText(copy.reviews.removeQuestion)).toBeInTheDocument();
    expect(copy.reviews.removeQuestion).toBe("Remove your review? It comes off Regulars and the places it was sent to.");
    expect(copy.reviews.removeConfirm).toBe("Remove");
    expect(copy.reviews.keep).toBe("Keep it");
    // The way out is where the focus goes.
    const keep = within(mine).getByRole("button", { name: copy.reviews.keep });
    expect(keep).toHaveFocus();
    expect(keep).toHaveAccessibleDescription(copy.reviews.removeQuestion);
    expect(within(mine).getByRole("group", { name: copy.reviews.removeQuestion })).toContainElement(
      within(mine).getByRole("button", { name: copy.reviews.removeConfirm }),
    );
    expect(me.addOn.signEvent).not.toHaveBeenCalled();

    await user.click(keep);
    expect(within(mine).queryByText(copy.reviews.removeQuestion)).not.toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: copy.reviews.remove })).toHaveFocus();
    expect(within(mine).getByText("Get the bolo")).toBeInTheDocument();

    // A double click only asks: its second click, landing on Remove once asked, does not confirm.
    await user.click(within(mine).getByRole("button", { name: copy.reviews.remove }));
    fireEvent.click(within(mine).getByRole("button", { name: copy.reviews.removeConfirm }), { detail: 2 });
    expect(within(mine).getByText(copy.reviews.removeQuestion)).toBeInTheDocument();
    expect(me.addOn.signEvent).not.toHaveBeenCalled();
    expect(sentTo(world, SEARCH)).toEqual([]);
  });

  it("signs one removal naming every version of the person's review of the place, and hides it once the review relay takes it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    // Reviewed with this app, and earlier with another one (the bare address as its d, and no a).
    const here = reviewBy(me.pubkey, 4, "Get the bolo", NOW_S - 60);
    const elsewhere = shapedEvent({
      kind: REVIEW_KIND,
      pubkey: me.pubkey,
      created_at: NOW_S - 3_600,
      content: "From another app",
      tags: [["d", JACAFE.address], ["s", "3"]],
    });
    world.search.push(here, elsewhere);
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter();
    // The person's own relay takes its time: the review is hidden without waiting for it.
    let answer!: () => void;
    world.writers[OWN] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    await removeIt(user);

    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    expect(noReviewWords("Get the bolo")).not.toBeInTheDocument();
    expect(noReviewWords("From another app")).not.toBeInTheDocument();
    expect(await screen.findByText(copy.place.beFirst)).toBeInTheDocument();

    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    const [removal] = sentTo(world, SEARCH);
    expect(verifyEvent(removal!)).toBe(true);
    expect(removal).toMatchObject({
      ...removalTemplate(
        [
          { id: here.id, pubkey: me.pubkey, d: `place:${JACAFE.address}` },
          { id: elsewhere.id, pubkey: me.pubkey, d: JACAFE.address },
        ],
        NOW_S,
      ),
      pubkey: me.pubkey,
    });
    expect(removal!.tags).toEqual([
      ["e", here.id],
      ["a", `${REVIEW_KIND}:${me.pubkey}:place:${JACAFE.address}`],
      ["e", elsewhere.id],
      ["a", `${REVIEW_KIND}:${me.pubkey}:${JACAFE.address}`],
      ["k", String(REVIEW_KIND)],
    ]);
    // The same removal goes to the relay the person writes to.
    expect(sentTo(world, OWN)).toEqual([removal]);
    answer();
  });

  it("sends the removal where a review just posted went, where the person writes now, and to the review relays", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.directory.push(listOf(me.pubkey, [OWN]));
    // The review relay takes the review, and lags: it is held, with where it went.
    world.writers[SEARCH] = createMemoryWriter();
    world.writers[OWN] = createMemoryWriter();
    world.writers[ANOTHER] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Get the bolo");
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    const review = sentTo(world, SEARCH)[0]!;
    await waitFor(() => expect(sentTo(world, OWN)).toEqual([review]));

    // Since then, the person writes somewhere else.
    world.directory.push({ ...listOf(me.pubkey, [ANOTHER]), created_at: 1_800_000_000 });
    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());

    const removal = sentTo(world, SEARCH)[1]!;
    expect(removal).toMatchObject({ kind: 5, created_at: NOW_S, tags: [["e", review.id], ["a", `${REVIEW_KIND}:${me.pubkey}:place:${JACAFE.address}`], ["k", "34259"]] });
    await waitFor(() => expect(sentTo(world, OWN)).toEqual([review, removal]));
    await waitFor(() => expect(sentTo(world, ANOTHER)).toEqual([removal]));
    // Held no longer: it is removed.
    expect(heldText()).toBeNull();
  });

  it("keeps the review hidden for this person when a relay that lags still sends it, after a reload too; others see it until their relays drop it (Review Focus 2)", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    // The relay takes the removal, and still sends the review: it lags.
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    await removeIt(user);
    await waitFor(() => expect(noReviewWords("Get the bolo")).not.toBeInTheDocument());

    // Reloaded: the relay sends the review again, and it stays hidden.
    cleanup();
    let reads = world.reviewReads;
    await open(world, [PLACE_PATH]);
    await waitFor(() => expect(world.reviewReads).toBeGreaterThan(reads));
    expect(await screen.findByText(copy.place.beFirst)).toBeInTheDocument();
    expect(noReviewWords("Get the bolo")).not.toBeInTheDocument();
    expect(noYourReview()).not.toBeInTheDocument();

    // Someone else, in a tab of their own, still sees it from the relay, until it drops it.
    window.sessionStorage.clear();
    cleanup();
    reads = world.reviewReads;
    await open(world, [PLACE_PATH]);
    expect(await reviewWords("Get the bolo")).toBeInTheDocument();
    expect(world.reviewReads).toBeGreaterThan(reads);
  });

  it("says the review came off the person's own places but not Regulars when only their relay takes the removal: Try again, and no Keep it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "rate-limited" });
    world.writers[OWN] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    const mine = await yourReview();
    expect(await within(mine).findByRole("alert")).toHaveTextContent(copy.reviews.removePartial);
    expect(copy.reviews.removePartial).toBe("Removed from your own places, but not from Regulars yet. Try again.");
    expect(within(mine).getByText("Get the bolo")).toBeInTheDocument();
    const again = within(mine).getByRole("button", { name: copy.reviews.removeAgain });
    expect(again).toHaveFocus();
    // It can't be taken back from the person's own places: there is no keeping it, by button or by Escape.
    expect(within(mine).queryByRole("button", { name: copy.reviews.keep })).not.toBeInTheDocument();
    expect(within(mine).queryByRole("link", { name: copy.reviews.edit })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(mine).getByRole("alert")).toHaveTextContent(copy.reviews.removePartial);
    expect(sentTo(world, OWN)).toHaveLength(1);

    // The review relay takes it the second time: the removal signed the first time, sent again
    // only where it was not taken.
    const first = sentTo(world, SEARCH)[0]!;
    world.writers[SEARCH] = createMemoryWriter();
    await user.click(again);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    expect(sentTo(world, SEARCH)).toEqual([first]);
    expect(sentTo(world, OWN)).toEqual([first]);
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("says the review didn't come off when no relay takes the removal, keeps it, with Try again and Keep it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.writers[SEARCH] = createMemoryWriter({ refuse: "rate-limited" });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    const mine = await yourReview();
    expect(await within(mine).findByRole("alert")).toHaveTextContent(copy.reviews.removeFailed);
    expect(copy.reviews.removeFailed).toBe("Your review didn't come off. Try again.");
    expect(within(mine).getByRole("button", { name: copy.reviews.removeAgain })).toHaveFocus();

    // Kept: the question goes, the review stays, and the focus is back on Remove.
    await user.click(within(mine).getByRole("button", { name: copy.reviews.keep }));
    expect(within(mine).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(mine).getByText("Get the bolo")).toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: copy.reviews.remove })).toHaveFocus();
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("closes the question with Escape, keeping the review, and gives the focus back to Remove; not while it is removing", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    let answer!: () => void;
    world.writers[SEARCH] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    const mine = await yourReview();
    await user.click(await removeButton(mine));
    expect(within(mine).getByRole("button", { name: copy.reviews.keep })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(within(mine).queryByText(copy.reviews.removeQuestion)).not.toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: copy.reviews.remove })).toHaveFocus();
    expect(me.addOn.signEvent).not.toHaveBeenCalled();

    // Once it is being removed, Escape leaves it to finish.
    await user.click(within(mine).getByRole("button", { name: copy.reviews.remove }));
    await user.click(within(mine).getByRole("button", { name: copy.reviews.removeConfirm }));
    const removing = await within(mine).findByRole("button", { name: copy.reviews.removing });
    await user.keyboard("{Escape}");
    expect(removing).toHaveAccessibleName(copy.reviews.removing);
    expect(within(mine).getByText(copy.reviews.removeQuestion)).toBeInTheDocument();
    answer();
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
  });

  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("puts Keep it where Remove was, and the Remove that confirms after it, so that two quick taps can't remove, on %s", async (_, px) => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH), px);

    const mine = await yourReview();
    const remove = await removeButton(mine);
    const row = remove.parentElement!;
    const rowClasses = row.className;
    const at = [...row.children].indexOf(remove);
    await user.click(remove);

    const keep = within(mine).getByRole("button", { name: copy.reviews.keep });
    expect(keep.parentElement).toBe(row);
    expect(row.className).toBe(rowClasses);
    expect([...row.children].indexOf(keep)).toBe(at);
    const confirm = within(mine).getByRole("button", { name: copy.reviews.removeConfirm });
    expect(row).not.toContainElement(confirm);
    expect(keep.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mine).getByText(copy.reviews.removeQuestion).compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(me.addOn.signEvent).not.toHaveBeenCalled();
  });

  it("puts the focus on the reviews once the review is removed, without scrolling, not on the page", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const bob = getPublicKey(generateSecretKey());
    world.ranks.push(rankOf(me.pubkey, 80), rankOf(bob, 50));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"), reviewBy(bob, 5, "Bob's words"));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));
    await reviewWords("Bob's words");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    const reviews = document.activeElement as HTMLElement;
    expect(reviews).not.toBe(document.body);
    expect(reviews).toHaveAttribute("tabindex", "-1");
    expect(within(reviews).getByRole("heading", { level: 2, name: copy.reviews.heading })).toBeInTheDocument();
    expect(focus.mock.contexts.at(-1)).toBe(reviews);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("puts the focus on where the reviews were when the person's was the only one", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
  });

  it("sends the removal to a relay the review was sent to that did not take it in time, which may have kept it", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.directory.push(listOf(me.pubkey, [OWN]));
    world.writers[SEARCH] = createMemoryWriter();
    world.writers[OWN] = createMemoryWriter({ refuse: "did not answer in time" });
    world.writers[ANOTHER] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH, REVIEW_PATH));

    await reviewingAs(me.name);
    await user.click((await starButtons())[3]!);
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    await waitFor(() => expect(sentTo(world, OWN)).toHaveLength(1));

    // The person writes somewhere else now; the relay that didn't answer still hears of the removal.
    world.directory.push({ ...listOf(me.pubkey, [ANOTHER]), created_at: 1_800_000_000 });
    world.writers[OWN] = createMemoryWriter();
    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    const removal = sentTo(world, SEARCH)[1]!;
    expect(removal).toMatchObject({ kind: 5 });
    await waitFor(() => expect(sentTo(world, OWN)).toEqual([removal]));
    await waitFor(() => expect(sentTo(world, ANOTHER)).toEqual([removal]));
  });

  it("says Removing… while it removes, and that it is removed once it is, in a polite live region", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    let answer!: () => void;
    world.writers[SEARCH] = createMemoryWriter({ until: new Promise<void>((resolve) => (answer = resolve)) });
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    const mine = await yourReview();
    const live = await waitFor(() => screen.getByText(copy.reviews.removing, { selector: '[role="status"]' }));
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).not.toContainElement(mine);
    expect(within(mine).getByRole("button", { name: copy.reviews.removing })).toHaveAttribute("aria-disabled", "true");
    expect(copy.reviews.removing).toBe("Removing…");

    // The same region says it is done, once the section has gone.
    answer();
    await waitFor(() => expect(live).toHaveTextContent(copy.reviews.removed));
    expect(live).toBeInTheDocument();
    expect(noYourReview()).not.toBeInTheDocument();
    expect(copy.reviews.removed).toBe("Your review is removed.");
  });

  it("sends the person to sign in when their add-on has changed accounts, and removes nothing", async () => {
    const world = newWorld();
    const me = signedIn(world, { signsWith: generateSecretKey() });
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
    expect(readSession()).toBeNull();
    expect(router.state.location.state).toMatchObject({ from: { pathname: PLACE_PATH } });
    expect(sentTo(world, SEARCH)).toEqual([]);
  });

  it("removes once when Remove is pressed twice before the page has redrawn: one signing, one send", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo"));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    const mine = await yourReview();
    await user.click(await removeButton(mine));
    const confirm = within(mine).getByRole("button", { name: copy.reviews.removeConfirm });
    await act(async () => {
      fireEvent.click(confirm, { detail: 1 });
      fireEvent.click(confirm, { detail: 1 });
    });
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    expect(me.addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(sentTo(world, SEARCH)).toHaveLength(1);
  });

  it("stamps the removal no earlier than the newest version it removes, so it takes that one too", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    // Edited twice in the same second, the second stamped a second later.
    world.search.push(reviewBy(me.pubkey, 4, "Get the bolo", NOW_S + 1));
    world.writers[SEARCH] = createMemoryWriter();
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    expect(sentTo(world, SEARCH)[0]).toMatchObject({ kind: 5, created_at: NOW_S + 1 });
  });
});

describe("rating a place again after removing a review", () => {
  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("posts a newer review, stamped after the removal, which shows, on %s", async (_, px) => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 2, "Slow tonight"));
    // The relay keeps what it is sent, and sends it back; it does not drop the removed review.
    world.writers[SEARCH] = createMemoryWriter({ into: world.search });
    const user = userEvent.setup();
    const { router } = await open(world, fromExplore(PLACE_PATH), px);

    await removeIt(user);
    await waitFor(() => expect(noYourReview()).not.toBeInTheDocument());
    const removal = sentTo(world, SEARCH)[0]!;
    expect(removal).toMatchObject({ kind: 5, created_at: NOW_S });

    // The form starts empty: the removed review is not the person's any more.
    await user.click(await rateLink(world));
    const stars = await starButtons();
    expect(stars.map((star) => star.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "false", "false"]);
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("");
    await user.click(stars[4]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Much better now");
    await user.click(postButton());
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));

    const review = sentTo(world, SEARCH)[1]!;
    expect(review).toMatchObject({ ...reviewTemplate(JACAFE, 5, "Much better now", NOW_S + 1), pubkey: me.pubkey });
    const mine = await yourReview();
    expect(within(mine).getByText("Much better now")).toBeInTheDocument();
    expect(noReviewWords("Slow tonight")).not.toBeInTheDocument();
    // It can be removed in its turn; nothing is said of the last one any more.
    expect(within(mine).getByRole("button", { name: copy.reviews.remove })).toBeInTheDocument();
    expect(screen.queryByText(copy.reviews.removed)).not.toBeInTheDocument();

    // Reloaded, the relay sends both, the removed one too: the new one shows, and only it.
    cleanup();
    const reads = world.reviewReads;
    await open(world, [PLACE_PATH]);
    await waitFor(() => expect(world.reviewReads).toBeGreaterThan(reads));
    expect(within(await yourReview()).getByText("Much better now")).toBeInTheDocument();
    expect(noReviewWords("Slow tonight")).not.toBeInTheDocument();
  });
});

describe("the person's own review: on its own, at the top of the reviews (R15)", () => {
  /** Bob, whom the house trusts, Carol, whom it does not, and the person, ranked `rank` (none: not ranked). */
  async function placeWith(rank: number | undefined, px = PHONE) {
    const world = newWorld();
    const me = signedIn(world);
    const bob = getPublicKey(generateSecretKey());
    const carol = getPublicKey(generateSecretKey());
    world.ranks.push(rankOf(bob, 50));
    if (rank !== undefined) world.ranks.push(rankOf(me.pubkey, rank));
    world.search.push(reviewBy(me.pubkey, 4, "My words"), reviewBy(bob, 5, "Bob's words"), reviewBy(carol, 2, "Carol's words"));
    const opened = await open(world, fromExplore(PLACE_PATH), px);
    return { world, me, ...opened };
  }

  /** The markup of an element, without the ids React makes, which differ from page to page. */
  const markupOf = (element: Element) => element.outerHTML.replace(/\s(?:id|aria-labelledby|aria-describedby|aria-controls)="[^"]*"/g, "");

  it("shows it under 'Your review', above the others, the same whether the house counts it or not, and never among them", async () => {
    const shown: string[] = [];
    for (const rank of [80, undefined]) {
      const { me } = await placeWith(rank);
      const mine = await yourReview();
      expect(within(mine).getByRole("heading", { level: 2, name: copy.reviews.yours })).toBeInTheDocument();
      expect(copy.reviews.yours).toBe("Your review");
      expect(within(mine).getByText("My words")).toBeInTheDocument();
      expect(within(mine).getByRole("link", { name: copy.reviews.edit })).toHaveAttribute("href", REVIEW_PATH);
      expect(within(mine).getByRole("button", { name: copy.reviews.remove })).toBeInTheDocument();
      expect(mine.querySelector("[data-folded]")).toBeNull();

      // Bob's is listed under the house's heading, after the person's; Carol's is folded; the person's is in neither.
      const heading = await screen.findByRole("heading", { level: 2, name: copy.reviews.heading });
      expect(mine.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const listed = heading.closest("section")!;
      expect(within(listed).getByText("Bob's words")).toBeInTheDocument();
      expect(within(listed).queryByText("My words")).not.toBeInTheDocument();
      expect(screen.getByText(copy.reviews.foldedMore(1))).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: copy.reviews.show }));
      expect(await reviewWords("Carol's words")).toBeInTheDocument();
      expect(screen.getAllByText("My words")).toHaveLength(1);

      // Taken once everything in it has come: the person's name (read in its own window, after the
      // reviews) and Remove, on once the session is restored. Before, it would differ by timing alone.
      expect(await within(mine).findByText(me.name)).toBeInTheDocument();
      await removeButton(mine);
      shown.push(markupOf(mine));
      cleanup();
    }
    // Nothing in it says whether the house counts it.
    expect(shown[0]).toBe(shown[1]);
  });

  it("is there on a desktop too, in the column, with Edit opening the form over the page, filled in", async () => {
    const { router } = await placeWith(80, DESKTOP);
    const user = userEvent.setup();
    const mine = await yourReview();
    expect(screen.getByRole("complementary", { name: copy.place.railLabel })).not.toContainElement(mine);

    await user.click(within(mine).getByRole("link", { name: copy.reviews.edit }));
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    await screen.findByRole("dialog", { name: copy.review.dialogLabel });
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("My words");
  });

  it("opens the form, filled in, by Edit on a phone, with the place as its way back", async () => {
    const { router } = await placeWith(undefined);
    const user = userEvent.setup();
    await user.click(within(await yourReview()).getByRole("link", { name: copy.reviews.edit }));
    expect(router.state.location.pathname).toBe(REVIEW_PATH);
    const stars = await starButtons();
    await waitFor(() => expect(stars[3]).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("textbox", { name: copy.review.textLabel })).toHaveValue("My words");
    await user.click(screen.getByRole("link", { name: copy.review.back }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    expect(router.state.historyAction).toBe("POP");
  });

  it("is not there for someone signed out, who sees the review where anyone's goes", async () => {
    const world = newWorld();
    const me = signedIn(world);
    window.sessionStorage.removeItem(SESSION_KEY);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "My words"));
    await open(world, fromExplore(PLACE_PATH));

    const heading = await screen.findByRole("heading", { level: 2, name: copy.reviews.heading });
    expect(within(heading.closest("section")!).getByText("My words")).toBeInTheDocument();
    expect(noYourReview()).not.toBeInTheDocument();
  });
});

describe("the person's own review, while their session is being restored", () => {
  it("shows under 'Your review' from the kept session, with Remove off: there is no one to sign the removal yet", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, 4, "My words"));
    account.restoring = true;
    const user = userEvent.setup();
    await open(world, fromExplore(PLACE_PATH));

    const mine = await yourReview();
    expect(within(mine).getByText("My words")).toBeInTheDocument();
    const remove = within(mine).getByRole("button", { name: copy.reviews.remove });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    await user.click(remove);
    expect(within(mine).queryByText(copy.reviews.removeQuestion)).not.toBeInTheDocument();
    // Never among the house's reviews meanwhile.
    expect(screen.queryByRole("heading", { name: copy.reviews.heading })).not.toBeInTheDocument();
  });
});

describe("list cards: the person is never one of the others (R16)", () => {
  /** The card or row that links to `place`'s page. */
  const linkTo = (place: Place) => screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/place/${encodeURIComponent(place.d)}`);

  it("says 'You've rated it' on an Explore card where only the person has rated the place, and counts only the others where they have too", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(reviewBy(me.pubkey, 4, "My words"));
    await open(world, ["/"]);
    await waitFor(() => expect(linkTo(JACAFE)).toHaveTextContent(copy.score.youRated));
    expect(linkTo(JACAFE)).not.toHaveTextContent(copy.score.othersRated(1));

    cleanup();
    world.search.push(reviewBy(getPublicKey(generateSecretKey()), 2, "Carol's words"));
    await open(world, ["/"]);
    await waitFor(() => expect(linkTo(JACAFE)).toHaveTextContent(copy.score.othersRated(1)));
    expect(linkTo(JACAFE)).not.toHaveTextContent(copy.score.othersRated(2));
  });

  it("says it on a chain's location row too", async () => {
    const world = newWorld();
    const me = signedIn(world);
    const chain = buildIndexes(parsePlaces(places)).chains.get("PT:a confeitaria coffee & bakery")!;
    const { lat, lon } = config.defaultCity;
    const [nearest] = [...chain.places].sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon));
    world.search.push(reviewOfPlace(me.pubkey, nearest!, 4, "My words"));
    await open(world, [`/chain/${chainSlug(chain)}`]);
    await waitFor(() => expect(linkTo(nearest!)).toHaveTextContent(copy.score.youRated));
    expect(linkTo(nearest!)).not.toHaveTextContent(copy.score.othersRated(1));
  });
});

describe("the panel of a place the person has rated: 'You've rated it', never one of the others (R15)", () => {
  const carol = getPublicKey(generateSecretKey());

  it.each([
    ["only they have rated it", (world: World) => world, [copy.score.youRated]],
    [
      "one other person, outside House picks, has too",
      (world: World) => {
        world.search.push(reviewBy(carol, 2, "Carol's words"));
        return world;
      },
      [copy.score.youRated, copy.score.othersRated(1)],
    ],
    [
      "the house can't be read",
      (world: World) => {
        world.search.push(reviewBy(carol, 2, "Carol's words"));
        world.houseDown = true;
        return world;
      },
      [copy.score.youRated, copy.score.othersRated(1)],
    ],
  ])("says so when %s", async (_, arrange, lines) => {
    const world = newWorld();
    const me = signedIn(world);
    world.search.push(reviewBy(me.pubkey, 4, "My words"));
    await open(arrange(world), fromExplore(PLACE_PATH));

    await yourReview();
    await waitFor(async () => expect(await noScoreLines()).toEqual(lines.map(copy.common.sentence)));
    expect(copy.score.youRated).toBe("You've rated it");
  });

  it("says nothing of whether the house counts a review the person wrote with no stars", async () => {
    const world = newWorld();
    const me = signedIn(world);
    world.ranks.push(rankOf(me.pubkey, 80));
    world.search.push(reviewBy(me.pubkey, null, "Words, no stars"));
    await open(world, fromExplore(PLACE_PATH));

    await yourReview();
    await waitFor(async () => expect(await noScoreLines()).toEqual([copy.common.sentence(copy.score.youRated)]));
    expect(screen.queryByRole("heading", { name: copy.reviews.heading })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/the house trusts reviewed it/);
  });
});

describe("no 'Be the first' or 'No reviews yet' before the reviews are asked for (R15)", () => {
  it("never shows 'Be the first' on a place's page while its reviews are read", async () => {
    const world = newWorld();
    const watch = watchFor(copy.place.beFirst);
    await openApp(PLACE_PATH, { events: places, readers: searchNeverAnswers(world), writers: writersOf(world) });
    await waitFor(() => expect(document.querySelector("section[aria-busy='true']")).not.toBeNull());
    expect(watch.seen()).toBe(false);
    watch.stop();
  });

  it("never shows 'No reviews yet' on a list's cards while their reviews are read", async () => {
    const world = newWorld();
    const watch = watchFor(copy.score.noReviewsYet);
    await openApp("/", { events: places, readers: searchNeverAnswers(world), writers: writersOf(world) });
    expect((await screen.findAllByRole("link", { name: new RegExp(JACAFE.name) })).length).toBeGreaterThan(0);
    expect(watch.seen()).toBe(false);
    watch.stop();
  });
});

describe("a kept session that can't be restored (R15)", () => {
  it("lets go of the person's held reviews, which are not shown while they appear signed out", async () => {
    const world = newWorld();
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    const held: NostrEvent = finalizeEvent(reviewTemplate(JACAFE, 4, "Held words", NOW_S - 30), key);
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify([{ event: held, relays: [SEARCH] }]));
    world.ranks.push(rankOf(pubkey, 80));
    restore.broken = true;
    await open(world, fromExplore(PLACE_PATH));

    // Signed out: Rate this place goes to sign in.
    await waitFor(async () => expect(await rateLink(world)).toHaveAttribute("href", "/signin"));
    await waitFor(() => expect(heldText()).toBeNull());
    expect(noReviewWords("Held words")).not.toBeInTheDocument();
    expect(noYourReview()).not.toBeInTheDocument();
  });
});

describe("the providers' order (R15)", () => {
  it("keeps the scores store outside the account, so that signing out can let go of held reviews", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const at = (text: string) => main.indexOf(text);
    expect(at("<ScoresProvider>")).toBeGreaterThan(-1);
    expect(at("<ScoresProvider>")).toBeLessThan(at("<AccountProvider>"));
    expect(at("</AccountProvider>")).toBeLessThan(at("</ScoresProvider>"));
  });
});
