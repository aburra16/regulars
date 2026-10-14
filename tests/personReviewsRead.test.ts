import { describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { askedStill, type Cursor, FIRST_ASK, limitOf, PERSON_ASK_MAX, PERSON_PAGE, ReviewsRead, type Sent, stepCursor } from "../src/person/reviewsRead";
import { REVIEW_KIND } from "../src/reviews/review";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

/*
 * How far the reading of one review relay has got, for a person's page (src/person/reviewsRead.ts):
 * the step from one page to the next, which is a pure function of where the relay stood, what it
 * sent, and whether another relay answered the page; and that the removals of the pages read go on
 * being read after one page's could not be taken in. (tests/personReviews.test.tsx has the reading
 * itself, on the page.)
 */

/** A page of `times.length` reviews of the person's, written at `times`, with nothing else in it. */
const page = (times: number[]): Sent => ({ count: times.length, times });
/** `n` reviews written a second apart, the newest at `newest`. */
const run = (n: number, newest: number) => Array.from({ length: n }, (_, i) => newest - i);
/** A cursor that has got to `until`, having had `again` reviews of that second; `left` when the relay was left for the visit. */
const at = (until: number, again: number, left = false): Cursor => ({ until, again, done: false, left });
/** A cursor of a relay that has sent everything it has, having got to `until` (nowhere, when its first page was its last). */
const done = (until?: number, again = 0): Cursor => ({ until, again, done: true, left: false });
/** Whether another relay answered the page: each way, where it makes no difference. */
const EITHER = [true, false];

describe("the first ask of a relay", () => {
  it("is for the newest page, of 20", () => {
    expect(FIRST_ASK).toEqual({ until: undefined, again: 0, done: false, left: false });
    expect(PERSON_PAGE).toBe(20);
    expect(limitOf(FIRST_ASK)).toBe(20);
    expect(askedStill(FIRST_ASK)).toBe(true);
  });
});

describe("the step from one page to the next", () => {
  it.each<[string, Cursor, Sent, Cursor]>([
    ["a short page is the relay's last", FIRST_ASK, page(run(7, 1_000)), done()],
    ["an empty page is its last", FIRST_ASK, page([]), done()],
    ["a short page later on is its last, and where it had got to stays", at(500, 1), page(run(20, 500)), done(500, 1)],
    ["a full page goes on from its oldest second, that second included, with the one review of it to come again", FIRST_ASK, page(run(20, 1_000)), at(981, 1)],
    ["the next full page goes on from its own oldest second", at(981, 1), page(run(21, 981)), at(961, 1)],
    [
      "a page that ends inside a second goes on from that second, with as many more asked as it had of it",
      FIRST_ASK,
      page([...run(17, 1_000), 900, 900, 900]),
      at(900, 3),
    ],
    ["a full page all of one second asks for that second again, and as many more", FIRST_ASK, page(Array<number>(20).fill(700)), at(700, 20)],
    ["a second that goes on growing is asked for with more each time", at(700, 20), page(Array<number>(40).fill(700)), at(700, 40)],
    ["a page as full as may be asked for, all of one second, still has room: 80 of it and 20 more", at(700, 60), page(Array<number>(80).fill(700)), at(700, 80)],
    ["a second with more in it than one request may ask for is left: on from the second before", at(700, 80), page(Array<number>(100).fill(700)), at(699, 0)],
    ["a full page with none of the person's reviews in it has no time to go on from: the relay's last", FIRST_ASK, { count: 20, times: [] }, done()],
    ["a relay that sends the reviews it sent before, and gets no further, does not page", at(981, 1), { count: 21, times: run(20, 1_000) }, done(981, 1)],
    ["a relay that sends a page newer than it was asked for does not page", at(500, 1), page(run(21, 900)), done(500, 1)],
    ["a full page that reaches the first second there is goes on from it", FIRST_ASK, page([...run(19, 19), 0]), at(0, 1)],
    ["a second 0 with more in it than may be asked for has no second before it: the relay's last", at(0, 80), page(Array<number>(100).fill(0)), done(0, 80)],
  ])("%s", (_, cursor, sent, next) => {
    expect(limitOf(cursor)).toBe(PERSON_PAGE + cursor.again);
    expect(sent.count <= limitOf(cursor)).toBe(true);
    // A relay that answered is stepped by what it sent alone: what another relay did with the page changes nothing.
    for (const anotherAnswered of EITHER) expect(stepCursor(cursor, sent, anotherAnswered)).toEqual(next);
  });

  it("counts a full page by everything the relay sent, not by the person's reviews in it", () => {
    // 20 sent, 18 of them the person's: the relay may have more.
    expect(stepCursor(FIRST_ASK, { count: 20, times: run(18, 1_000) }, false)).toEqual(at(983, 1));
    // 19 sent: it has no more.
    expect(stepCursor(FIRST_ASK, { count: 19, times: run(19, 1_000) }, false).done).toBe(true);
  });

  it("never asks for more than a request may hold", () => {
    expect(PERSON_ASK_MAX).toBe(100);
    // A second that fills every page it is asked for: the asks grow to the most, and no further.
    let cursor = FIRST_ASK;
    const asked: number[] = [];
    while (cursor.until === undefined || cursor.until === 700) {
      asked.push(limitOf(cursor));
      cursor = stepCursor(cursor, page(Array<number>(limitOf(cursor)).fill(700)), false);
    }
    expect(asked).toEqual([20, 40, 60, 80, 100]);
    expect(cursor).toEqual(at(699, 0));
  });

  it("changes nothing of the cursor it is given", () => {
    const cursor = at(981, 1);
    const kept = { ...cursor };
    stepCursor(cursor, page(run(21, 981)), true);
    stepCursor(cursor, null, true);
    stepCursor(cursor, null, false);
    expect(cursor).toEqual(kept);
    expect(Object.isFrozen(FIRST_ASK)).toBe(true);
  });
});

describe("a relay that does not answer a page (rulings R37 and R38)", () => {
  it.each<[string, Cursor, boolean, Cursor]>([
    ["is left for the visit at once when another relay answered the page, on the first page", FIRST_ASK, true, { until: undefined, again: 0, done: false, left: true }],
    ["is left at once on a later page too, and where it had got to stays", at(981, 1), true, at(981, 1, true)],
    ["stands where it stood when no relay answered the page: it is asked for the first page again", FIRST_ASK, false, FIRST_ASK],
    ["stands where it stood on a later page nobody answered: the same page again", at(981, 1), false, at(981, 1)],
  ])("%s", (_, cursor, anotherAnswered, next) => {
    expect(stepCursor(cursor, null, anotherAnswered)).toEqual(next);
  });

  it("is asked no more once it is left, and is asked still while no relay answers, however often that is", () => {
    expect(askedStill(stepCursor(FIRST_ASK, null, true))).toBe(false);
    expect(askedStill(stepCursor(at(981, 1), null, true))).toBe(false);

    // A page nobody answers, tried again and again: nothing is counted against the relay.
    let cursor = at(981, 1);
    for (let tries = 0; tries < 50; tries++) cursor = stepCursor(cursor, null, false);
    expect(cursor).toEqual(at(981, 1));
    expect(askedStill(cursor)).toBe(true);
    expect(limitOf(cursor)).toBe(21);
  });

  it("loses nothing when a page nobody answered is asked for again and it answers: it sends the page it missed", () => {
    const missed = stepCursor(at(981, 1), null, false);
    expect(limitOf(missed)).toBe(21);
    expect(missed.until).toBe(981);
    expect(stepCursor(missed, page(run(21, 981)), false)).toEqual(at(961, 1));
  });

  it("is asked no more once it has sent everything", () => {
    const sentAll = stepCursor(stepCursor(FIRST_ASK, null, false), page(run(3, 1_000)), true);
    expect(sentAll).toEqual(done());
    expect(askedStill(sentAll)).toBe(false);
  });
});

describe("a relay that was left (rulings R37 and R42)", () => {
  it("is told apart from one that sent everything by its cursor alone, whether it had answered before or never did", () => {
    // Left after a full page: what it had left to send was not read.
    const answered = stepCursor(FIRST_ASK, page(run(20, 1_000)), true);
    expect(answered.left).toBe(false);
    expect(stepCursor(answered, null, true).left).toBe(true);
    // Left before it ever answered: whether it had anything is not known.
    expect(stepCursor(FIRST_ASK, null, true).left).toBe(true);
  });

  it.each<[string, Cursor]>([
    ["one that has sent everything", done(981, 1)],
    ["one that sent everything after a page nobody answered", stepCursor(stepCursor(FIRST_ASK, null, false), page([]), true)],
    ["one that is asked still", at(981, 1)],
    ["one that stands where it stood because no relay answered", stepCursor(at(981, 1), null, false)],
    ["one that has not been asked yet", FIRST_ASK],
  ])("is not %s", (_, cursor) => {
    expect(cursor.left).toBe(false);
  });
});

describe("the removals of a person's reviews", () => {
  it("go on being read for the pages after one whose removals could not be taken in", async () => {
    config.reviewRelays = ["wss://reviews.example.test"];
    const sol = hex64("5");
    // 30 reviews, two pages; the first page's has a removal.
    const reviews = Array.from({ length: 30 }, (_, i) =>
      shapedEvent({ kind: REVIEW_KIND, pubkey: sol, created_at: 1_700_000_000 - i, tags: [["d", `d-${i}`], ["m", "place"]] }),
    );
    const removal = shapedEvent({ kind: 5, pubkey: sol, created_at: 1_700_000_100, tags: [["e", reviews[0]!.id]] });
    const reader = createMemoryReader([...reviews, removal]);
    const read = new ReviewsRead(sol, () => reader);
    // Something that hears the reading fails once, as the first removal is taken in.
    let failed = false;
    read.subscribe(() => {
      if (failed || read.snapshot().removals.length === 0) return;
      failed = true;
      throw new Error("A listener failed");
    });
    const notes = vi.spyOn(console, "debug").mockImplementation(() => {});
    const removalReads = () => reader.requests.filter((filter) => filter.kinds?.includes(5));
    read.start();
    await vi.waitFor(() => expect(failed).toBe(true));

    await read.readMore(true);
    await vi.waitFor(() => expect(removalReads()).toHaveLength(4));
    // The second page begins at the second the first ended in, which it sends again.
    expect(removalReads()[2]?.["#e"]).toEqual(reviews.slice(19).map((review) => review.id));
    expect(notes).toHaveBeenCalledWith(expect.stringContaining("removals"), expect.any(Error));
    read.stop();
    notes.mockRestore();
  });
});
