import type { NostrFilter } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../src/circle/brainstorm";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { PERSON_ASK_MAX, PERSON_PAGE, PERSON_READ_MS } from "../src/person/reviewsRead";
import { PERSON_PAGES_PER_ASK } from "../src/person/usePersonReviews";
import { parsePlaces } from "../src/places/load";
import { REVIEW_KIND } from "../src/reviews/review";
import { HELD_REVIEWS_KEY, REMOVED_REVIEWS_KEY } from "../src/score/store";
import { hex64, shapedEvent } from "./support/events";
import { gate, signedInAs } from "./support/followPage";
import { after, endScene, type Logs, person, startScene } from "./support/followScene";
import { type Relay, silentWhen } from "./support/followWorld";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import { asksForReviews, at, bothHold, JACAFE, listed, LISTED, lists, MAIA, main, MAYA, MAYA_SECRET, MUSEU, open, openSol, pathsOf, placePath, reviewAsks, reviewOf, reviewsPart, scene, showMore, SOL, SOL_PATH, SOL_SECRET, solOn, tryAgain, unlisted } from "./support/personScene";
import { places, reviewOfPlace, SEARCH } from "./support/reviewWorld";

/*
 * A person's reviews on their page (src/person/usePersonReviews.ts, src/person/PersonPage.tsx): what
 * is asked of the review relays, which reviews are shown (by the rules a place's page and Trending
 * have), 20 at a time with Show more, and where the reading of them stands: loading, none, not read,
 * and a review relay that is out. (tests/personPage.test.tsx has the page's frame.)
 *
 * `changeFollow` is mocked around the real one, and Brainstorm's client is mocked: each of its network
 * calls is a stand-in that a test can count. The relays are held in memory, the keys are thrown away,
 * and nothing opens a socket or reaches the network (tests/setup.ts; the set-up is shared with the
 * page's other tests, tests/support/personScene.ts).
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn(actual.changeFollow) };
});
const change = vi.mocked(changeFollow);

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

describe("what a person's page asks the review relays", () => {
  it("asks each review relay for their reviews of places, 20 at a time, with what a read from that relay adds", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 4, "Sit outside", at(1))]);
    await openSol(s);
    await lists([JACAFE]);

    expect(PERSON_PAGE).toBe(20);
    // Brainstorm's search relay is asked for what it takes for spam too (decision 16), as every read of reviews asks it.
    expect(reviewAsks(s.search)).toEqual([{ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 20, search: "include:spam" }]);
    expect(reviewAsks(s.second)).toEqual([{ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 20 }]);
    // No follow-list relay is asked for a review, and nothing was written anywhere.
    expect(s.follows.asked().filter(asksForReviews)).toEqual([]);
    expect(s.follows.published()).toEqual([]);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("which reviews a person's page shows", () => {
  it("shows one review of each place, the newest, whichever relay sent it and however often", async () => {
    const s = scene();
    const first = solOn(JACAFE, 2, "Too loud", at(50));
    // The same place again under another `d`, as another app writes it: the newer of the two stands.
    const again = shapedEvent({
      kind: REVIEW_KIND,
      pubkey: SOL,
      created_at: at(3),
      content: "Better on a weekday",
      tags: [["d", JACAFE.address], ["m", "place"], ["s", "4"]],
    });
    const maia = solOn(MAIA, 5, "The best pastel de nata", at(10));
    // One relay lags: it still has the version of Maia's review that the other has replaced.
    const maiaBefore = solOn(MAIA, 1, "Closed when I came", at(40));
    s.search.held.push(first, again, maia);
    s.second.held.push(first, maiaBefore, maia, again);
    await openSol(s);

    await lists([JACAFE, MAIA]);
    expect(within(reviewOf(JACAFE)).getByText("Better on a weekday")).toBeInTheDocument();
    expect(within(reviewOf(MAIA)).getByText("The best pastel de nata")).toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("Too loud")).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("Closed when I came")).not.toBeInTheDocument();
  });

  it("shows one review of a place the list has twice, the newer, whichever of its two addresses each was written for", async () => {
    // Jacafé filed a second time, under another `d`: the same place (brief § 4.3).
    const jacafe = places.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === JACAFE.d))!;
    const again = { ...jacafe, id: hex64("9"), tags: jacafe.tags.map((tag) => (tag[0] === "d" ? ["d", "jacafe-again"] : tag)) };
    const JACAFE_AGAIN = parsePlaces([again])[0]!;
    expect(JACAFE_AGAIN.osmId).toBe(JACAFE.osmId);
    const s = scene();
    bothHold(s, [solOn(JACAFE, 2, "Before they changed hands", at(40)), solOn(JACAFE_AGAIN, 5, "Much better now", at(3)), solOn(MAIA, 4, "Worth the walk", at(10))]);
    await openSol(s, { events: [...places, again] });

    await waitFor(() => expect(listed()).toEqual([placePath(JACAFE_AGAIN), placePath(MAIA)]));
    expect(within(reviewsPart()).getByText("Much better now")).toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("Before they changed hands")).not.toBeInTheDocument();
  });

  it("leaves out, saying nothing, a review of a place that is not on the list, one dated ahead of the clock, and anything that is no review of theirs", async () => {
    // A relay that sends what was not asked for, after what was: another person's review, and a note of Sol's.
    const strays = [
      reviewOfPlace(hex64("e"), MUSEU, 1, "Not Sol's", at(2)),
      shapedEvent({ kind: 1, pubkey: SOL, content: "A note", created_at: at(3), tags: [["d", `place:${MUSEU.address}`], ["m", "place"]] }),
    ];
    const s = scene({
      second: {
        reads: (reader) => ({
          async *req(filter, signal) {
            yield* reader.req(filter, signal);
            if (asksForReviews(filter)) yield* strays;
          },
        }),
      },
    });
    const tomorrowAndMore = Math.floor(Date.now() / 1000) + 3 * 86_400;
    bothHold(s, [
      solOn(unlisted(1), 5, "It closed last year", at(1)),
      solOn(MAIA, 5, "From next week", tomorrowAndMore),
      solOn(JACAFE, 4, "Sit outside", at(5)),
    ]);
    await openSol(s);

    await lists([JACAFE]);
    expect(within(reviewsPart()).queryByText("It closed last year")).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("From next week")).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("Not Sol's")).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText("A note")).not.toBeInTheDocument();
    expect(showMore()).not.toBeInTheDocument();
  });

  it("does not show a review the person removed in this tab, though a relay that lags still sends it", async () => {
    const s = scene();
    signedInAs(SOL_SECRET);
    const removed = solOn(JACAFE, 4, "I take this back", at(20));
    bothHold(s, [removed, solOn(MAIA, 5, "This one stays", at(5))]);
    // Removed a minute ago, on the place's page: the tab keeps that, as the place's page does.
    window.sessionStorage.setItem(REMOVED_REVIEWS_KEY, JSON.stringify([[`${REVIEW_KIND}:${SOL}:place:${JACAFE.address}`, at(0)]]));
    await openSol(s);

    await lists([MAIA]);
    expect(within(reviewsPart()).queryByText("I take this back")).not.toBeInTheDocument();
  });

  it("does not list a review its author removed, though only one relay sends the removal, and the next page loads as it would have", async () => {
    const s = scene();
    const reviews = LISTED.slice(0, 25).map((place, i) => solOn(place, 4, `Words about ${place.d}`, at(i)));
    bothHold(s, reviews);
    const removed = reviews[3]!;
    // Removed in another app a minute ago, by id and by address, as both apps write a removal.
    const removal = shapedEvent({
      kind: 5,
      pubkey: SOL,
      created_at: at(0),
      tags: [["e", removed.id], ["a", `${REVIEW_KIND}:${SOL}:place:${LISTED[3]!.address}`], ["k", String(REVIEW_KIND)]],
    });
    s.second.held.push(removal);
    const user = person();
    await openSol(s);

    const shown = (n: number) => LISTED.slice(0, n).filter((_, i) => i !== 3);
    await lists(shown(20));
    expect(within(reviewsPart()).queryByText(`Words about ${LISTED[3]!.d}`)).not.toBeInTheDocument();
    // Each relay that answered was asked for the removals of the reviews the page brought, by id and by address.
    for (const [from, extras] of [
      [s.search, { search: "include:spam" }],
      [s.second, {}],
    ] as const) {
      const asked = from.asked.filter((filter) => filter.kinds?.includes(5));
      expect(asked).toEqual([
        { kinds: [5], "#e": expect.any(Array), limit: 500, ...extras },
        { kinds: [5], "#a": expect.any(Array), limit: 500, ...extras },
      ]);
      expect([...asked[0]!["#e"]!].sort()).toEqual(reviews.slice(0, 20).map((review) => review.id).sort());
    }

    // The next page is asked for from where the first ended, as without the removal, and shows the rest.
    await user.click(showMore()!);
    await lists(shown(25));
    expect(reviewAsks(s.search)[1]).toEqual({ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 21, until: at(19), search: "include:spam" });
    expect(reviewAsks(s.second)[1]).toEqual({ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 21, until: at(19) });
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
  });

  it("shows, on the person's own page, a review they posted in this tab that the relays have not sent back yet", async () => {
    const s = scene();
    signedInAs(SOL_SECRET);
    bothHold(s, [solOn(MAIA, 5, "Read from the relays", at(5))]);
    const held = solOn(JACAFE, 4, "Posted a moment ago", at(0));
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify([{ event: held, relays: [SEARCH] }]));
    await openSol(s);

    await lists([JACAFE, MAIA]);
    expect(within(reviewOf(JACAFE)).getByText("Posted a moment ago")).toBeInTheDocument();
  });
});

describe("whose reviews a person's page shows", () => {
  it("shows none of the reviews of the person signed in on someone else's page, though the tab holds one they have just posted", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene();
    bothHold(s, [solOn(MAIA, 5, "Sol's own words", at(5))]);
    const held = reviewOfPlace(MAYA, JACAFE, 4, "Maya posted this a moment ago", at(0));
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify([{ event: held, relays: [SEARCH] }]));
    await openSol(s);

    await lists([MAIA]);
    expect(within(reviewsPart()).queryByText("Maya posted this a moment ago")).not.toBeInTheDocument();
  });
});

describe("a person's reviews, 20 at a time", () => {
  /** Sol's reviews of the first `n` places on the list, the `i`th written at `at(i)`: the list's order is the page's. */
  const reviewsOfFirst = (n: number) => LISTED.slice(0, n).map((place, i) => solOn(place, 4, `Words about ${place.d}`, at(i)));
  const first = (n: number) => LISTED.slice(0, n);

  it("shows the first 20, then 20 more on Show more, each asked for from where the last ended, and no button once all are shown", async () => {
    expect(LISTED.length).toBeGreaterThanOrEqual(43);
    const s = scene();
    bothHold(s, reviewsOfFirst(43));
    const user = person();
    await openSol(s);

    await lists(first(20));
    expect(reviewAsks(s.search)).toHaveLength(1);
    const button = showMore()!;
    expect(button).toHaveClass("h-13");

    await user.click(button);
    await lists(first(40));
    // The next page is asked for up to the oldest review of the last, that second included: the one
    // review of that second comes again, so one more is asked for, and the page brings 20 new ones.
    expect(reviewAsks(s.search)[1]).toEqual({ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 21, until: at(19), search: "include:spam" });
    expect(reviewAsks(s.second)[1]).toEqual({ kinds: [REVIEW_KIND], authors: [SOL], "#m": ["place"], limit: 21, until: at(19) });
    // The focus goes to the first review the page brought, as Explore's Show more puts it on its first new place.
    expect(within(reviewOf(LISTED[20]!)).getByRole("link")).toHaveFocus();

    await user.click(showMore()!);
    await lists(first(43));
    expect(reviewAsks(s.search)).toHaveLength(3);
    expect(reviewAsks(s.search)[2]).toMatchObject({ limit: 21, until: at(39) });
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(within(reviewOf(LISTED[40]!)).getByRole("link")).toHaveFocus();
    // Never how many there are, of reviews or of anything else about the person.
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveTextContent(/^Reviews$/);
    expectNoNumbersAboutPeople([]);
  });

  it("loses no review and shows none twice when a page ends inside one second", async () => {
    const s = scene();
    // The 19th to the 22nd were written in the same second: the first page ends among them.
    const reviews = LISTED.slice(0, 30).map((place, i) => solOn(place, 4, `Words about ${place.d}`, i >= 18 && i <= 21 ? at(18) : at(i)));
    bothHold(s, reviews);
    const user = person();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));

    await user.click(showMore()!);

    // The two of that second the first page had come again, and are shown once; the two it had no room for come too.
    await waitFor(() => expect(listed()).toHaveLength(30));
    expect(reviewAsks(s.search)[1]).toMatchObject({ limit: 22, until: at(18) });
    expect([...listed()].sort()).toEqual(pathsOf(first(30)).sort());
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
  });

  it("reads a second with more reviews in it than a page holds to its end, by asking for that many more", async () => {
    const s = scene();
    // 25 reviews in one second, then older ones.
    const reviews = LISTED.slice(0, 30).map((place, i) => solOn(place, 4, `Words about ${place.d}`, i < 25 ? at(0) : at(i)));
    bothHold(s, reviews);
    const user = person();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));

    await user.click(showMore()!);

    await waitFor(() => expect(listed()).toHaveLength(30));
    expect(reviewAsks(s.search).map((filter) => [filter.until, filter.limit])).toEqual([
      [undefined, 20],
      [at(0), 40],
    ]);
    expect([...listed()].sort()).toEqual(pathsOf(first(30)).sort());
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
  });

  it("leaves a second with more reviews in it than one request may ask for, and goes on from the second before", async () => {
    const s = scene();
    // More in one second than a relay is ever asked for at once, all of places that are not on the list; and three older ones of places that are.
    const flood = PERSON_ASK_MAX + PERSON_PAGE;
    bothHold(s, [...Array.from({ length: flood }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(0))), ...LISTED.slice(0, 3).map((place, i) => solOn(place, 5, "Still here", at(5 + i)))]);
    const user = person();
    await openSol(s);
    await waitFor(() => expect(showMore()).toBeInTheDocument());

    await user.click(showMore()!);

    await lists(first(3));
    expect(reviewAsks(s.search).map((filter) => [filter.until, filter.limit])).toEqual([
      [undefined, 20],
      [at(0), 40],
      [at(0), 60],
      [at(0), 80],
      [at(0), 100],
      [at(0) - 1, 20],
    ]);
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
  });

  it("stops asking a relay that gets no further back whatever it is asked: it does not page, and Show more is not left for good", async () => {
    // A relay that takes no notice of `until`: it sends its newest reviews every time.
    const s = scene({
      second: {
        reads: (reader) => ({
          async *req(filter, signal) {
            const { until: _, ...rest } = filter;
            yield* reader.req(asksForReviews(filter) ? rest : filter, signal);
          },
        }),
      },
    });
    s.second.held.push(...LISTED.slice(0, 30).map((place, i) => solOn(place, 4, "Words", at(i))));
    const user = person();
    await openSol(s);
    await lists(first(20));

    // Asked for one more than a page, it sends its newest 21: one of them is new.
    await user.click(showMore()!);
    await lists(first(21));
    // Asked from where that ended, it sends the same 21: it is asked no more.
    await user.click(showMore()!);

    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(reviewAsks(s.second)).toHaveLength(3);
    expect(listed()).toEqual(pathsOf(first(21)));
    expect(within(reviewOf(LISTED[20]!)).getByRole("link")).toHaveFocus();
  });

  it("keeps Show more, busy, while the next reviews are read, takes no second press, and leaves the list as it was", async () => {
    const s = scene();
    bothHold(s, reviewsOfFirst(30));
    const user = person();
    await openSol(s);
    await lists(first(20));
    const held = gate();
    const slow = (from: Relay) => {
      const reader = from.reader;
      from.reader = {
        async *req(filter, signal) {
          if (filter.until !== undefined) await held.closed;
          yield* reader.req(filter, signal);
        },
      };
    };
    slow(s.search);
    slow(s.second);

    const button = showMore()!;
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    expect(listed()).toEqual(pathsOf(first(20)));
    await user.click(button);
    await held.open();

    await lists(first(30));
    expect(reviewAsks(s.search)).toHaveLength(2);
  });

  it("reads on by itself past a page with no review of a place on the list, and never says there are none while more may come", async () => {
    const s = scene();
    // The 20 newest are of places that are no longer on the list; the next three are of places that are.
    bothHold(s, [...Array.from({ length: 20 }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(i))), ...LISTED.slice(0, 3).map((place, i) => solOn(place, 5, "Still here", at(20 + i)))]);
    const said: string[] = [];
    const watch = new MutationObserver(() => said.push(main().textContent ?? ""));
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    await openSol(s);

    await lists(first(3));
    watch.disconnect();
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(said.some((text) => text.includes(copy.person.none))).toBe(false);
    expect(within(reviewsPart()).queryByText(/Gone/)).not.toBeInTheDocument();
    expect(showMore()).not.toBeInTheDocument();
  });

  it("stops reading by itself after a few pages with nothing to show, and leaves Show more, which reads on: never an empty page that looks finished", async () => {
    const s = scene();
    const gone = PERSON_PAGE * PERSON_PAGES_PER_ASK + 5;
    bothHold(s, [...Array.from({ length: gone }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(i))), solOn(JACAFE, 5, "Still here", at(gone))]);
    const user = person();
    await openSol(s);

    // Three pages were read by themselves, with nothing to show: the page asks before it reads more.
    await waitFor(() => expect(showMore()).toBeInTheDocument());
    expect(reviewAsks(s.search)).toHaveLength(PERSON_PAGES_PER_ASK);
    expect(listed()).toEqual([]);
    expect(within(reviewsPart()).queryByText(copy.person.none)).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.loading)).not.toBeInTheDocument();

    const button = showMore()!;
    await user.click(button);

    await lists([JACAFE]);
    expect(within(reviewOf(JACAFE)).getByRole("link")).toHaveFocus();
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
  });

  it("says No reviews yet only once every review is read and none is of a place on the list", async () => {
    const s = scene();
    bothHold(s, Array.from({ length: 25 }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(i))));
    await openSol(s);

    expect(await within(reviewsPart()).findByText(copy.person.none)).toBeInTheDocument();
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(showMore()).not.toBeInTheDocument();
    expect(listed()).toEqual([]);
  });

  it("puts the focus on the last review when Show more brings nothing and there is no more to read", async () => {
    const s = scene();
    // 20 of places on the list, and then only reviews of places that are not.
    bothHold(s, [...reviewsOfFirst(20), ...Array.from({ length: 5 }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(30 + i)))]);
    const user = person();
    await openSol(s);
    await lists(first(20));

    await user.click(showMore()!);

    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(listed()).toEqual(pathsOf(first(20)));
    expect(within(reviewOf(LISTED[19]!)).getByRole("link")).toHaveFocus();
  });
});

describe("where the reading of a person's reviews stands", () => {
  /** Holds every read of reviews from `from` until the gate it gives is opened. */
  function holdReviews(...from: Relay[]) {
    const held = gate();
    for (const each of from) {
      const reader = each.reader;
      each.reader = {
        async *req(filter, signal) {
          if (asksForReviews(filter)) await Promise.race([held.closed, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
          yield* reader.req(filter, signal);
        },
      };
    }
    return held;
  }

  it("says it is loading while they are read, politely, and then shows them", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 4, "Sit outside", at(1))]);
    const held = holdReviews(s.search, s.second);
    await openSol(s);

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    expect(status).toHaveTextContent(copy.person.loading);
    expect(listed()).toEqual([]);
    expect(within(reviewsPart()).queryByText(copy.person.none)).not.toBeInTheDocument();
    expect(showMore()).not.toBeInTheDocument();

    await held.open();

    await lists([JACAFE]);
    expect(status).toBeEmptyDOMElement();
  });

  it("says No reviews yet when the relays answered and they have none", async () => {
    const s = scene();
    await openSol(s);

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.none));
    expect(status).toHaveTextContent(/^No reviews yet\.$/);
    expect(showMore()).not.toBeInTheDocument();
    expect(tryAgain()).not.toBeInTheDocument();
  });

  it("says the reviews couldn't be loaded when no review relay answered, with Try again, which reads them", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 4, "Sit outside", at(1))]);
    s.search.down = true;
    s.second.down = true;
    const user = person();
    await open(s);
    // Their name is on those relays too: until one answers, they are Someone.
    await within(main()).findByRole("heading", { level: 1, name: copy.reviews.someone });

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    expect(within(reviewsPart()).queryByText(copy.person.none)).not.toBeInTheDocument();
    expect(listed()).toEqual([]);
    // The relays are not asked again and again: once, until the person asks.
    expect(reviewAsks(s.search)).toHaveLength(1);

    s.search.down = false;
    s.second.down = false;
    await user.click(tryAgain()!);

    await lists([JACAFE]);
    expect(status).toBeEmptyDOMElement();
    expect(tryAgain()).not.toBeInTheDocument();
    // The button went as it was pressed: the focus is on the part of the page it was in, not on nothing.
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveFocus();
    // Their name is read again with their reviews.
    expect(await within(main()).findByRole("heading", { level: 1, name: "Sol" })).toBeInTheDocument();
    expect(document.title).toBe(copy.titles.person("Sol"));
  });

  it("shows what one review relay has when the other does not answer, and Show more goes on with the one that does", async () => {
    const s = scene();
    s.search.held.push(...LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i))));
    s.second.down = true;
    const user = person();
    await openSol(s);

    await waitFor(() => expect(listed()).toHaveLength(20));
    expect(within(reviewsPart()).queryByText(copy.person.failed)).not.toBeInTheDocument();
    await user.click(showMore()!);

    await waitFor(() => expect(listed()).toHaveLength(25));
    // The one that answers has sent everything, and the other was left when it failed the first page,
    // which that one answered: nothing is left to ask, so the control goes, and nothing says a relay was out.
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(tryAgain()).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.failed)).not.toBeInTheDocument();
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(2);
  });

  it("leaves out a review relay that does not answer in time, and shows what the other has", async () => {
    const s = scene({ second: { reads: silentWhen(asksForReviews) } });
    s.search.held.push(solOn(JACAFE, 4, "Sit outside", at(1)));
    await openSol(s);
    await waitFor(() => expect(reviewAsks(s.search)).toHaveLength(1));
    expect(listed()).toEqual([]);
    expect(within(reviewsPart()).getAllByRole("status")[0]).toHaveTextContent(copy.person.loading);

    await after(PERSON_READ_MS);

    await lists([JACAFE]);
  });

  it("says so beside the list when more could not be read, and its Try again, the same button, reads them", async () => {
    const s = scene();
    bothHold(s, LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i))));
    const user = person();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));
    s.search.down = true;
    s.second.down = true;

    const button = showMore()!;
    await user.click(button);

    const status = within(reviewsPart()).getAllByRole("status")[1]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    // The list stays, and the button is the one that was pressed, with the focus still on it.
    expect(listed()).toHaveLength(20);
    expect(button).toHaveTextContent(copy.person.retry);
    expect(button).toHaveFocus();
    // The line is under the button, as a Follow button's lines are: the button that was pressed is where it was.
    expect(button.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(reviewsPart()).getAllByRole("status")[0]).toBeEmptyDOMElement();

    s.search.down = false;
    s.second.down = false;
    await user.click(button);

    await waitFor(() => expect(listed()).toHaveLength(25));
    expect(status).toBeEmptyDOMElement();
  });

  it("keeps the line and Try again for as long as no relay answers, however often it is pressed, reads nothing by itself meanwhile, and reads on once a relay is back (ruling R38)", async () => {
    const s = scene();
    bothHold(s, LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i))));
    const user = person();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));
    s.search.down = true;
    s.second.down = true;
    const button = showMore()!;
    await user.click(button);
    const status = within(reviewsPart()).getAllByRole("status")[1]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    expect(button).toHaveTextContent(copy.person.retry);
    expect(reviewAsks(s.search)).toHaveLength(2);

    // Pressed again and again: the same relays are asked each time, and the line and the button come back as they were.
    for (const asked of [3, 4, 5, 6]) {
      await user.click(button);
      await waitFor(() => expect(reviewAsks(s.search)).toHaveLength(asked));
      await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
      expect(reviewAsks(s.second)).toHaveLength(asked);
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent(copy.person.retry);
      expect(button).toHaveFocus();
      expect(listed()).toHaveLength(20);
      expect(within(reviewsPart()).getAllByRole("status")[0]).toBeEmptyDOMElement();
    }
    // Each ask after the first page was for the same page: the one nobody answered.
    for (const each of [s.search, s.second]) {
      expect(new Set(reviewAsks(each).slice(1).map((filter) => `${filter.until} ${filter.limit}`))).toEqual(new Set([`${at(19)} ${PERSON_PAGE + 1}`]));
    }
    // And nothing asks again by itself, however long the page stays open.
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.search)).toHaveLength(6);
    expect(reviewAsks(s.second)).toHaveLength(6);

    // One relay is back. Try again reads the rest from it; the other did not answer a page that one did, and is left.
    s.search.down = false;
    await user.click(button);

    await waitFor(() => expect(listed()).toHaveLength(25));
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(tryAgain()).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.failed)).not.toBeInTheDocument();
    expect(within(reviewOf(LISTED[20]!)).getByRole("link")).toHaveFocus();
    expect(reviewAsks(s.search)).toHaveLength(7);
    expect(reviewAsks(s.second)).toHaveLength(7);
    // The relay that was left is back too, and is not asked: nothing is left to ask for.
    s.second.down = false;
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.second)).toHaveLength(7);
  });

  it("stops reading when the person leaves the page, and takes nothing that comes after", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 4, "Sit outside", at(1))]);
    const held = holdReviews(s.search, s.second);
    const signals: AbortSignal[] = [];
    for (const each of [s.search, s.second]) {
      const reader = each.reader;
      each.reader = {
        req(filter, signal) {
          if (asksForReviews(filter)) signals.push(signal);
          return reader.req(filter, signal);
        },
      };
    }
    const { router } = await openSol(s);
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    await act(() => router.navigate("/about"));

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await held.open();
    expect(await screen.findByRole("heading", { level: 1, name: copy.about.title })).toBeInTheDocument();
  });

  it("reads and shows the reviews in React's strict mode, which runs every effect twice", async () => {
    const s = scene();
    bothHold(s, LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i))));
    const user = person();
    await openSol(s, { strict: true });

    await waitFor(() => expect(listed()).toHaveLength(20));
    await user.click(showMore()!);
    await waitFor(() => expect(listed()).toHaveLength(25));
    expect(new Set(listed()).size).toBe(25);
  });
});

describe("a review relay that is out (rulings R33, R37 and R38)", () => {
  /** What the page says of the reading, under the heading and under the list. */
  const said = () => within(reviewsPart()).getAllByRole("status").map((status) => status.textContent);
  /** Notes every line the reviews' part ever says, from now on. */
  function everSaid() {
    const lines = new Set<string>();
    const watch = new MutationObserver(() => {
      for (const status of document.querySelectorAll("main section [role=status]")) if (status.textContent !== "") lines.add(status.textContent ?? "");
    });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    return { lines, stop: () => watch.disconnect() };
  }

  it("shows the reviews one relay has, with no Show more once that relay has sent everything: the one that is out is left at once, and nothing says so", async () => {
    const s = scene();
    s.search.held.push(solOn(JACAFE, 5, "Get the bolo de caco", at(2)), solOn(MAIA, 3, "Slow", at(30)), solOn(MUSEU, 4, "Quiet", at(40)));
    s.second.down = true;
    const ever = everSaid();
    await openSol(s);

    await lists([JACAFE, MAIA, MUSEU]);
    // The relay that answered has sent everything, and the other was left for the visit when it failed
    // the page that one answered: no relay is left to ask, and no control offers what could only fail.
    expect(said()).toEqual(["", ""]);
    expect(showMore()).not.toBeInTheDocument();
    expect(tryAgain()).not.toBeInTheDocument();
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(1);
    // Nothing ever said the reviews could not be loaded: one relay answered.
    ever.stop();
    expect([...ever.lines].filter((line) => line !== copy.person.loading)).toEqual([]);
    // And nothing asks again however long the page stays open.
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(1);
  });

  it("says the reviews couldn't be loaded, not No reviews yet, when the relay that answered has none and the other is out: one that never answered may hold them (ruling R42)", async () => {
    const s = scene();
    s.second.down = true;
    const user = person();
    const ever = everSaid();
    await openSol(s);

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    // The relay that is out was asked once, with the first page, and left: nothing waited on it, and it is not asked again by itself.
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(1);
    expect(showMore()).not.toBeInTheDocument();
    expect(tryAgain()).toBeInTheDocument();
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(status).toHaveTextContent(copy.person.failed);

    // Try again begins the visit again, as often as it is pressed: both are asked, and the one that is out is left again.
    await user.click(tryAgain()!);
    await waitFor(() => expect(reviewAsks(s.second)).toHaveLength(2));
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveFocus();

    // Once it answers, with none: every relay has answered in full, and the person has no reviews.
    s.second.down = false;
    await user.click(tryAgain()!);
    await waitFor(() => expect(status).toHaveTextContent(copy.person.none));
    expect(tryAgain()).not.toBeInTheDocument();
    expect(reviewAsks(s.second)).toHaveLength(3);
    ever.stop();
    // "No reviews yet." was said only then: never while a relay had not answered.
    expect([...ever.lines]).toEqual([copy.person.loading, copy.person.failed, copy.person.none]);
  });

  it("does not ask a relay again in the visit once it failed a page another answered, though it is back; a new visit to the page asks it, and shows what only it has", async () => {
    const s = scene();
    const shared = LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i)));
    // One review that only the second relay has, among its older ones.
    const itsOwn = solOn(LISTED[30]!, 5, "Only the second relay has this", at(22) - 1);
    s.search.held.push(...shared);
    s.second.held.push(...shared, itsOwn);
    s.second.down = true;
    const user = person();
    const ever = everSaid();
    const { router } = await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));
    s.second.down = false;

    // Show more goes on with the relay that answered, and with no other.
    await user.click(showMore()!);
    await waitFor(() => expect(listed()).toHaveLength(25));
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(reviewAsks(s.second)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(within(reviewsPart()).queryByText("Only the second relay has this")).not.toBeInTheDocument();
    ever.stop();
    expect(ever.lines.has(copy.person.failed)).toBe(false);

    // The page left and opened again is a new visit: every relay is asked, from its newest page.
    await act(() => router.navigate("/about"));
    await act(() => router.navigate(SOL_PATH));
    await waitFor(() => expect(listed()).toHaveLength(20));
    expect(reviewAsks(s.second)).toHaveLength(2);
    expect(reviewAsks(s.second)[1]).toMatchObject({ limit: 20 });
    expect(reviewAsks(s.second)[1]).not.toHaveProperty("until");
    await user.click(showMore()!);
    await waitFor(() => expect(listed()).toHaveLength(26));
    expect(within(reviewsPart()).getByText("Only the second relay has this")).toBeInTheDocument();
  });

  it("says the reviews couldn't be loaded when the only relay with a review failed the first page, which another answered; Try again asks it again, and finds the review (ruling R42)", async () => {
    const s = scene();
    s.second.held.push(solOn(JACAFE, 5, "Get the bolo de caco", at(2)));
    // The second relay fails its first ask, and answers after.
    let asks = 0;
    const reader = s.second.reader;
    s.second.reader = {
      async *req(filter, signal) {
        if (asksForReviews(filter) && asks++ === 0) throw new Error("this relay is out for a moment");
        yield* reader.req(filter, signal);
      },
    };
    const user = person();
    const ever = everSaid();
    await openSol(s);

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    // It never answered, so the page cannot say the person has no reviews: it was left, and nothing asks it again by itself.
    expect(asks).toBe(1);
    expect(showMore()).not.toBeInTheDocument();
    await after(PERSON_READ_MS * 3);
    expect(asks).toBe(1);

    await user.click(tryAgain()!);

    await lists([JACAFE]);
    expect(asks).toBe(2);
    expect(status).toBeEmptyDOMElement();
    expect(tryAgain()).not.toBeInTheDocument();
    ever.stop();
    expect(ever.lines.has(copy.person.none)).toBe(false);
  });

  it("reads all there is from two of three relays when the third is out, with no word of it: the third is asked once", async () => {
    const s = scene({ third: {} });
    bothHold(s, LISTED.slice(0, 25).map((place, i) => solOn(place, 4, "Words", at(i))));
    s.third!.down = true;
    const user = person();
    const ever = everSaid();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));

    await user.click(showMore()!);

    await waitFor(() => expect(listed()).toHaveLength(25));
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(tryAgain()).not.toBeInTheDocument();
    expect(reviewAsks(s.third!)).toHaveLength(1);
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(reviewAsks(s.second)).toHaveLength(2);
    ever.stop();
    expect(ever.lines.has(copy.person.failed)).toBe(false);
  });

  it("goes on with one of three relays when the second fails a later page that the first answers, and the third was out from the start", async () => {
    const s = scene({ third: {} });
    // 43 reviews, as the paging tests above have: three pages of them.
    bothHold(s, LISTED.slice(0, 43).map((place, i) => solOn(place, 4, "Words", at(i))));
    s.third!.down = true;
    const user = person();
    const ever = everSaid();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));
    s.second.down = true;

    await user.click(showMore()!);
    await waitFor(() => expect(listed()).toHaveLength(40));
    // The first relay may have more: Show more is still there, and asks it alone.
    await user.click(showMore()!);

    await waitFor(() => expect(listed()).toHaveLength(43));
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(reviewAsks(s.search)).toHaveLength(3);
    expect(reviewAsks(s.second)).toHaveLength(2);
    expect(reviewAsks(s.third!)).toHaveLength(1);
    ever.stop();
    expect(ever.lines.has(copy.person.failed)).toBe(false);
    expect(ever.lines.has(copy.person.none)).toBe(false);
  });

  it("does not ask a relay that was left again while it reads on by itself past pages with nothing to show", async () => {
    const s = scene();
    // Three pages of reviews of places that are not on the list, and then one of a place that is.
    const gone = PERSON_PAGE * 2 + 5;
    s.search.held.push(...Array.from({ length: gone }, (_, i) => solOn(unlisted(i), 3, `Gone ${i}`, at(i))), solOn(JACAFE, 5, "Still here", at(gone)));
    s.second.down = true;
    await openSol(s);

    await lists([JACAFE]);
    expect(reviewAsks(s.search)).toHaveLength(3);
    expect(reviewAsks(s.second)).toHaveLength(1);
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(tryAgain()).not.toBeInTheDocument();
  });

  /** `n` reviews of Sol's of places that are not on the list, the `i`th written at `at(from + i)`. */
  const goneFrom = (from: number, n: number) => Array.from({ length: n }, (_, i) => solOn(unlisted(from + i), 3, `Gone ${from + i}`, at(from + i)));
  /** Makes `from` fail the `nth` time it is asked for reviews (from 0), and answer every other time. What it was asked for reviews, that time among them, in order. */
  function failsItsAsk(from: Relay, nth: number) {
    const reader = from.reader;
    const asks: NostrFilter[] = [];
    from.reader = {
      async *req(filter, signal) {
        if (asksForReviews(filter) && asks.push(filter) === nth + 1) throw new Error("this relay is out for a moment");
        yield* reader.req(filter, signal);
      },
    };
    return asks;
  }

  it("says the reviews couldn't be loaded, and never No reviews yet, when nothing is listed and a relay that had more to send was left; Try again begins the visit again, and finds them (ruling R37)", async () => {
    const s = scene();
    // Both relays have 22 reviews of places that are not on the list. The search relay has 20 more of
    // them, older, and after those the one review of a place that is.
    s.search.held.push(...goneFrom(0, 42), solOn(JACAFE, 5, "Still here", at(50)));
    s.second.held.push(...goneFrom(0, 22));
    // The search relay sends a full first page, and is out for the second, which the other relay answers.
    const searchAsks = failsItsAsk(s.search, 1);
    const user = person();
    const ever = everSaid();
    await openSol(s);

    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    // Nothing is listed, and no relay is left to ask: one has sent everything, the other was left with more.
    expect(listed()).toEqual([]);
    expect(showMore()).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.none)).not.toBeInTheDocument();
    expect(searchAsks).toHaveLength(2);
    expect(reviewAsks(s.second)).toHaveLength(2);
    // Nothing reads again by itself.
    await after(PERSON_READ_MS * 3);
    expect(searchAsks).toHaveLength(2);
    expect(status).toHaveTextContent(copy.person.failed);

    await user.click(tryAgain()!);

    // The visit begins again: each relay is asked from its newest page, the one that was left among them.
    await lists([JACAFE]);
    expect(searchAsks[2]).not.toHaveProperty("until");
    expect(reviewAsks(s.second)[2]).not.toHaveProperty("until");
    expect(searchAsks).toHaveLength(5);
    expect(reviewAsks(s.second)).toHaveLength(4);
    expect(status).toBeEmptyDOMElement();
    expect(tryAgain()).not.toBeInTheDocument();
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    // The button went as it was pressed: the focus is on the part of the page it was in.
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveFocus();
    ever.stop();
    expect(ever.lines.has(copy.person.none)).toBe(false);
  });

  it("says nothing, and offers nothing, when a relay that had more to send was left and reviews are listed: Show more goes with the last relay that answers", async () => {
    const s = scene();
    // Both have the 22 newest; the search relay has five older ones besides.
    const newest = LISTED.slice(0, 22).map((place, i) => solOn(place, 4, "Words", at(i)));
    s.search.held.push(...newest, ...LISTED.slice(22, 27).map((place, i) => solOn(place, 4, "Older words", at(22 + i))));
    s.second.held.push(...newest);
    const user = person();
    const ever = everSaid();
    await openSol(s);
    await waitFor(() => expect(listed()).toHaveLength(20));
    s.search.down = true;

    await user.click(showMore()!);

    // The other relay answered the page, with its last: the search relay is left, and what only it has is not read.
    await waitFor(() => expect(listed()).toHaveLength(22));
    await waitFor(() => expect(showMore()).not.toBeInTheDocument());
    expect(tryAgain()).not.toBeInTheDocument();
    expect(said()).toEqual(["", ""]);
    expect(within(reviewOf(LISTED[20]!)).getByRole("link")).toHaveFocus();
    ever.stop();
    expect([...ever.lines].filter((line) => line !== copy.person.loading)).toEqual([]);
    // It is back, and is not asked: the visit has left it.
    s.search.down = false;
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(listed()).toHaveLength(22);
  });

  it("says the reviews couldn't be loaded when Show more ends so with nothing listed, with the focus on the reviews' heading, not on nothing (ruling R37)", async () => {
    const s = scene();
    // More pages of reviews of places that are not on the list than the page reads by itself, on both relays.
    const gone = PERSON_PAGE * PERSON_PAGES_PER_ASK + 5;
    s.search.held.push(...goneFrom(0, gone + 30));
    s.second.held.push(...goneFrom(0, gone));
    const user = person();
    const ever = everSaid();
    await openSol(s);
    await waitFor(() => expect(showMore()).toBeInTheDocument());
    expect(listed()).toEqual([]);
    s.search.down = true;

    const button = showMore()!;
    await user.click(button);

    // The second relay sent its last, and the search relay, which had more, did not answer that page.
    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    expect(button).not.toBeInTheDocument();
    expect(showMore()).not.toBeInTheDocument();
    expect(tryAgain()).toBeInTheDocument();
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveFocus();
    ever.stop();
    expect(ever.lines.has(copy.person.none)).toBe(false);

    // Try again begins the visit again, as when the page was opened: it says it is loading, and reads from the newest.
    s.search.down = false;
    const asked = reviewAsks(s.search).length;
    const again = everSaid();
    // Whether Show more is ever there, busy, while the pages are read: it is not on arrival.
    let busyShowMore = false;
    const watch = new MutationObserver(() => {
      if (showMore()?.getAttribute("aria-busy") === "true") busyShowMore = true;
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true });
    await user.click(tryAgain()!);
    await waitFor(() => expect(reviewAsks(s.search).length).toBeGreaterThan(asked));
    expect(reviewAsks(s.search)[asked]).not.toHaveProperty("until");
    await waitFor(() => expect(showMore()).toBeInTheDocument());
    expect(status).toBeEmptyDOMElement();
    expect(listed()).toEqual([]);
    // Loading, through the pages it reads by itself, as on arrival; and never that there are none.
    again.stop();
    watch.disconnect();
    expect([...again.lines]).toEqual([copy.person.loading]);
    expect(busyShowMore).toBe(false);
    expect(reviewAsks(s.search)).toHaveLength(asked + PERSON_PAGES_PER_ASK);
  });

  it("starts the visit afresh on the first page's Try again: every relay is asked again, from its newest page", async () => {
    const s = scene();
    s.search.held.push(solOn(JACAFE, 5, "Get the bolo de caco", at(2)));
    s.search.down = true;
    s.second.down = true;
    const user = person();
    await open(s);
    await within(main()).findByRole("heading", { level: 1, name: copy.reviews.someone });
    const status = within(reviewsPart()).getAllByRole("status")[0]!;
    await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
    // Nothing more is asked until the person asks: no relay is tried a second time by itself.
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.search)).toHaveLength(1);
    expect(reviewAsks(s.second)).toHaveLength(1);

    // One relay is back. The other fails again, a page the first now answers: it is left for the visit begun anew.
    s.search.down = false;
    await user.click(tryAgain()!);

    await lists([JACAFE]);
    expect(reviewAsks(s.search)).toHaveLength(2);
    expect(reviewAsks(s.second)).toHaveLength(2);
    for (const each of [s.search, s.second]) expect(reviewAsks(each).map((filter) => filter.until)).toEqual([undefined, undefined]);
    // The relay that answered has sent everything, and the other is left: there is nothing more to ask for.
    expect(showMore()).not.toBeInTheDocument();
    expect(tryAgain()).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.failed)).not.toBeInTheDocument();
    await after(PERSON_READ_MS * 3);
    expect(reviewAsks(s.second)).toHaveLength(2);
  });

  it("says the reviews couldn't be loaded again when the first page's Try again finds no relay either, as often as the person asks", async () => {
    const s = scene();
    s.search.down = true;
    s.second.down = true;
    const user = person();
    await open(s);
    await within(main()).findByRole("heading", { level: 1, name: copy.reviews.someone });
    const status = within(reviewsPart()).getAllByRole("status")[0]!;

    for (const asked of [1, 2, 3]) {
      await waitFor(() => expect(reviewAsks(s.search)).toHaveLength(asked));
      await waitFor(() => expect(status).toHaveTextContent(copy.person.failed));
      expect(reviewAsks(s.second)).toHaveLength(asked);
      await user.click(tryAgain()!);
    }
    await waitFor(() => expect(reviewAsks(s.search)).toHaveLength(4));
  });
});
