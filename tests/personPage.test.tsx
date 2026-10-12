import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../src/circle/brainstorm";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { placeKindLabel } from "../src/places/kinds";
import { whenWritten } from "../src/reviews/when";
import { DESKTOP, PHONE, resizeTo } from "./support/app";
import { endScene, type Logs, person, startScene } from "./support/followScene";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import { at, bothHold, expectNoProtocolWords, header, JACAFE, listed, lists, MAIA, main, MUSEU, open, openSol, pathsOf, placePath, reviewAsks, reviewOf, reviewsPart, scene, showMore, SOL, SOL_PATH, solOn } from "./support/personScene";
import { profileOf } from "./support/reviewWorld";

/*
 * A person's page, `/person/<npub>`, in the app itself (src/person/PersonPage.tsx): its frame. Their
 * name, which is the page's heading, and their picture or initial; the way back; the order the page
 * is read in; and the two layouts, a phone's and a desktop's. (tests/personReviews.test.tsx has their
 * reviews, tests/personFollow.test.tsx the Follow button and the person's own page,
 * tests/personFollowedBy.test.tsx who follows them, and tests/personRoute.test.tsx the route.)
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

describe("a person's page", () => {
  it("shows their name and their reviews of places on the list, newest first: the place, a link to it, what it is, the stars, when, and the words", async () => {
    const s = scene();
    bothHold(s, [
      solOn(MAIA, 3, "Slow, but the cakes are worth it", at(30)),
      solOn(JACAFE, 5, "Get the bolo de caco", at(2)),
      solOn(MUSEU, null, "A quiet corner at the back", at(9)),
    ]);
    const { router } = await openSol(s);

    await lists([JACAFE, MUSEU, MAIA]);
    // The page's heading is the person's name, kept apart from the direction of the words around it.
    const name = within(main()).getByRole("heading", { level: 1, name: "Sol" });
    expect(name.querySelector("bdi")).toHaveTextContent("Sol");
    expect(document.title).toBe(copy.titles.person("Sol"));
    // The heading over the reviews says what they are, and never how many (decision 19).
    expect(within(reviewsPart()).getByRole("heading", { level: 2 })).toHaveTextContent(/^Reviews$/);

    const jacafe = reviewOf(JACAFE);
    const link = within(jacafe).getByRole("link", { name: JACAFE.name });
    expect(link).toHaveAttribute("href", placePath(JACAFE));
    expect(within(jacafe).getByText(placeKindLabel(JACAFE.category, JACAFE.cuisine))).toBeInTheDocument();
    expect(within(jacafe).getByRole("img", { name: copy.score.starsLabel(5) })).toBeInTheDocument();
    const when = jacafe.querySelector("time")!;
    expect(when).toHaveAttribute("datetime", new Date(at(2) * 1000).toISOString());
    expect(when).toHaveTextContent(whenWritten(at(2), new Date()));
    expect(within(jacafe).getByText("Get the bolo de caco")).toBeInTheDocument();
    // A review with words and no stars shows its words, and no stars.
    expect(within(reviewOf(MUSEU)).getByText("A quiet corner at the back")).toBeInTheDocument();
    expect(within(reviewOf(MUSEU)).queryByRole("img")).not.toBeInTheDocument();
    // The rows are the person's own: none repeats their name, and none has a Follow button.
    expect(within(reviewsPart()).queryByText("Sol")).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByRole("button")).not.toBeInTheDocument();
    // Read to the end: nothing more to show, and nothing says so.
    expect(showMore()).not.toBeInTheDocument();
    expect(within(reviewsPart()).queryByText(copy.person.none)).not.toBeInTheDocument();
    expectNoProtocolWords();
    expectNoNumbersAboutPeople([]);

    await person().click(link);
    expect(router.state.location.pathname).toBe(placePath(JACAFE));
  });

  it("shows their picture when their profile gives one, by the rules a review's has, and their initial when it gives none", async () => {
    const s = scene();
    s.search.held.splice(0, 1, profileOf(SOL, "Sol", "https://pictures.example.test/sol.jpg"));
    await openSol(s);

    const picture = await waitFor(() => {
      const img = main().querySelector("img");
      expect(img).not.toBeNull();
      return img!;
    });
    expect(picture).toHaveAttribute("src", "https://pictures.example.test/sol.jpg");
    // Told nothing of where it is shown, and no part of what a screen reader hears: the name is beside it.
    expect(picture).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(picture).toHaveAttribute("alt", "");
    expect(picture.closest("[aria-hidden=true]")).not.toBeNull();
  });

  it("shows their initial in place of a picture that will not load", async () => {
    const s = scene();
    s.search.held.splice(0, 1, profileOf(SOL, "Sol", "https://pictures.example.test/gone.jpg"));
    await openSol(s);
    const picture = await waitFor(() => {
      const img = main().querySelector("img");
      expect(img).not.toBeNull();
      return img!;
    });

    fireEvent.error(picture);

    expect(main().querySelector("img")).toBeNull();
    expect(within(header()).getByText("S").closest("[aria-hidden=true]")).not.toBeNull();
  });

  it.each([
    ["an address that is not https", "http://pictures.example.test/sol.jpg"],
    ["no picture", undefined],
  ])("shows the person's initial for %s", async (_, address) => {
    const s = scene();
    s.search.held.splice(0, 1, profileOf(SOL, "Sol", address));
    await openSol(s);

    expect(main().querySelector("img")).toBeNull();
    const initial = within(main()).getByText("S");
    expect(initial.closest("[aria-hidden=true]")).not.toBeNull();
  });

  it("calls a person whose profile gives no name Someone, as a review does, and never by a code", async () => {
    const s = scene();
    s.search.held.splice(0, 1);
    bothHold(s, [solOn(JACAFE, 4, "Sit outside", at(1))]);
    await open(s);

    expect(await within(main()).findByRole("heading", { level: 1, name: copy.reviews.someone })).toBeInTheDocument();
    await lists([JACAFE]);
    expect(document.title).toBe(copy.titles.person(copy.reviews.someone));
    expect(main()).not.toHaveTextContent(/npub1/);
    expect(main()).not.toHaveTextContent(SOL);
  });
});

describe("the way back from a person's page", () => {
  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("goes back the way the person came, in the word Back, on %s", async (_, px) => {
    const s = scene();
    const user = person();
    const { router } = await open(s, SOL_PATH, { px, entries: [placePath(JACAFE), SOL_PATH] });
    await screen.findByRole("heading", { level: 1, name: "Sol" });

    const back = within(main()).getByRole("link", { name: copy.person.back });
    expect(back).toHaveAccessibleName("Back");
    await user.click(back);

    expect(router.state.location.pathname).toBe(placePath(JACAFE));
  });

  it("goes to Explore when the person's page was the first page opened, and says so", async () => {
    const s = scene();
    const user = person();
    const { router } = await openSol(s);

    const back = within(main()).getByRole("link", { name: copy.place.backHome });
    expect(within(main()).queryByRole("link", { name: copy.person.back })).not.toBeInTheDocument();
    await user.click(back);

    expect(router.state.location.pathname).toBe("/");
  });
});

describe("a person's page on a desktop", () => {
  it("has the same name and reviews, in a column beside a side rail", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2)), solOn(MAIA, 3, "Slow", at(30))]);
    await openSol(s, { px: DESKTOP });

    await lists([JACAFE, MAIA]);
    expect(within(main()).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(reviewOf(JACAFE)).getByRole("link", { name: JACAFE.name })).toHaveAttribute("href", placePath(JACAFE));
  });

  it("lays the page out the other way when the window crosses 900 px, and reads nothing again", async () => {
    const s = scene();
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s, { px: PHONE });
    await lists([JACAFE]);

    act(() => resizeTo(DESKTOP));

    expect(listed()).toEqual(pathsOf([JACAFE]));
    expect(reviewAsks(s.search)).toHaveLength(1);
  });
});
