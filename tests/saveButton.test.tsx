import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { parsePlaces } from "../src/places/load";
import { TOWNS_WAIT_MS } from "../src/places/store";
import { forgetSavedFloor } from "../src/saved/change";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { type AddOn, asksFirst, gate, installAddOn, signedInAs } from "./support/followPage";
import { type RelayOptions, strangers, type World } from "./support/followWorld";
import { asksForSaved, SAVED_RELAYS, savedWorld, setUpSavedRelays } from "./support/savedWorld";
import { fromExplore, JACAFE, newWorld, PLACE_PATH, places, readersOf, writersOf } from "./support/reviewWorld";

/*
 * The Save button on the real page of a place, in the app itself (src/saved/SaveButton.tsx): the
 * bookmark at the top right of a phone's page, and Save among the desktop rail's actions. These hold
 * it to a link to sign in for someone signed out, which saves nothing; to a toggle for someone signed
 * in, which a press changes by the real `changeSaved` over relays held in memory; to Saving… while
 * that is made; and to the lines under it, each failure's with Try again and a first save's with the
 * way to Saved. (tests/savedProvider.test.tsx holds the list behind it.) The keys are thrown away,
 * and nothing opens a socket.
 */

// The sign-in page looks for an add-on a moment after the page loads: here it has just loaded, and
// the look ends at once with what the page has (src/signin/addOn.ts, whose clock tests/addOn.test.ts plays).
vi.mock("../src/signin/addOn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/addOn")>();
  return { ...actual, msSinceLoad: () => 0, lookForAddOn: async () => actual.hasAddOn() };
});

const SECRET = generateSecretKey();

/** Another place of the list, which a list may hold besides Jacafé. */
const ANOTHER_PLACE = parsePlaces(places).find((place) => place.d !== JACAFE.d)!;
/** A place's entry in a list, as a save writes it. */
const entry = (address: string) => ["a", address, config.placesRelay];

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** A list of the person's saved places, truly signed, holding `addresses`. */
const savedList = (...addresses: string[]): NostrEvent =>
  asSent(
    finalizeEvent(
      { kind: 30003, created_at: 1_700_000_000, tags: [["d", "regulars-saved"], ["title", "Saved places"], ...addresses.map(entry)], content: "" },
      SECRET,
    ),
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

interface Opening {
  px?: number;
  /** The lists each saved-list relay holds. Default: none, so the person has saved nothing. */
  lists?: NostrEvent[];
  /** Whether the person is signed in with this tab's add-on as the page opens. Default: yes. */
  signIn?: boolean;
  /** How each saved-list relay answers. */
  relays?: RelayOptions;
}

/**
 * Jacafé's page, opened from Explore, with the person's saved places on five relays held in memory
 * and the reviews and the house's ranks on the review world's. Signed in, it resolves once the
 * person's list has been read, unless the relays hold it back.
 */
async function openPlace({ px = PHONE, lists = [], signIn = true, relays }: Opening = {}) {
  const w = savedWorld(lists, relays);
  const reviews = newWorld();
  const addOn: AddOn | undefined = signIn ? signedInAs(SECRET) : undefined;
  const app = await openApp(PLACE_PATH, {
    events: places,
    px,
    entries: fromExplore(PLACE_PATH),
    readers: (url) => w.relays[url]?.reader ?? readersOf(reviews)(url),
    writers: (url) => w.relays[url]?.writer ?? writersOf(reviews)(url),
  });
  await screen.findByRole("heading", { level: 1, name: JACAFE.name });
  return { ...app, w, addOn };
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

/** The phone's bookmark for someone signed in: a toggle, named Save in either state; Saving… while a change is made. */
const bookmark = (name: string = copy.saved.save) => screen.getByRole("button", { name });
/** The desktop's rail. */
const rail = () => within(screen.getByRole("complementary"));
/** The bookmark the phone's button draws: filled once the place is saved, outlined before. */
const drawn = (button: HTMLElement) => (button.querySelector("svg path")?.getAttribute("fill") === "currentColor" ? "filled" : "outlined");
/** The polite status under the button that says `line`. */
const saying = (line: string) => screen.getByText(line).closest<HTMLElement>('[role="status"]');
/** Try again, under the button. */
const tryAgain = () => screen.queryByRole("button", { name: copy.saved.tryAgain });

/** The person, at a keyboard and a pointer, with the fake clock moved on as they wait. */
const person = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

/** What the app logs: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  config.features.saved = true;
  setUpSavedRelays(config);
  strangers.length = 0;
  forgetSavedFloor();
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

describe("Save, for someone signed out", () => {
  it.each([
    ["the phone's bookmark", PHONE, copy.place.save],
    ["the rail's Save", DESKTOP, copy.place.saveShort],
  ])("is %s, a link to sign in, which comes back to the place and saves nothing", async (_, px, name) => {
    const user = person();
    const { router, w } = await openPlace({ px, signIn: false });
    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", "/signin");
    // Nobody's list is read for someone signed out.
    expect(w.asked().filter(asksForSaved)).toEqual([]);

    const addOn = installAddOn(SECRET);
    await user.click(link);
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: PLACE_PATH } });
    await user.click(await screen.findByRole("button", { name: copy.signin.continueButton }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    await screen.findByRole("heading", { level: 1, name: JACAFE.name });

    // Signed in, the list is read, and nothing is saved: the person presses Save themself.
    await waitFor(() => expect(w.asked().filter(asksForSaved)).toHaveLength(SAVED_RELAYS.length));
    const save = await screen.findByRole("button", { name: copy.saved.save, pressed: false });
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);

    await user.click(save);
    // Named Save in either look, and pressed: the rail's word to see says Saved.
    const saved = await screen.findByRole("button", { name: copy.saved.save, pressed: true });
    expect(saved.textContent).toBe(px === PHONE ? "" : copy.saved.saved);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([JACAFE.address]);
  });
});

describe("Save on a phone", () => {
  it("is the bookmark at the top right, across from the way back, named Save for a screen reader", async () => {
    await openPlace();
    const save = bookmark();
    const back = screen.getByRole("link", { name: copy.place.back });
    expect(save.parentElement).toBe(back.parentElement);
    expect(save.parentElement!.lastElementChild).toBe(save);
    // The bookmark alone, with no word to see: its name is for a screen reader.
    expect(save.textContent).toBe("");
    expect(save.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(save).toHaveClass("size-11");
  });

  it("says Save, outlined, before the list is read and for a place not saved, and Saved, filled, for one saved, as a toggle a press changes", async () => {
    const user = person();
    const reads = heldBack();
    const { w, addOn } = await openPlace({ lists: [savedList(JACAFE.address)], relays: reads.relays });

    // Before the list is read: Save.
    expect(bookmark()).toHaveAttribute("aria-pressed", "false");
    expect(drawn(bookmark())).toBe("outlined");
    await reads.open();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "true"));
    expect(drawn(bookmark())).toBe("filled");

    // A press takes it out of the list.
    await user.click(bookmark());
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));
    expect(drawn(bookmark())).toBe("outlined");
    expect(addOn!.signEvent).toHaveBeenCalledTimes(1);
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([]);
  });

  it("says Saving… while the change is made, with the bookmark as it was, and can't be pressed again till it has ended", async () => {
    const user = person();
    const { addOn } = await openPlace();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    const approve = asksFirst(addOn!, SECRET);
    await user.click(bookmark());
    const saving = await screen.findByRole("button", { name: copy.saved.saving });
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(saving).toHaveAttribute("aria-pressed", "false");
    expect(drawn(saving)).toBe("outlined");
    // The same button throughout: the focus stays on it.
    expect(saving).toHaveFocus();
    await user.click(saving);
    await user.keyboard("{Enter}");

    await approve.yes();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "true"));
    expect(bookmark()).toBe(saving);
    expect(addOn!.signEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a first save, whose line takes its place", [], copy.saved.firstSave],
    ["a save onto a list with a place in it, which leaves nothing to say", [savedList(ANOTHER_PLACE.address)], undefined],
  ])("says Saving… under the page's header while the change is made, in the lines' polite status, until it has ended: %s", async (_, lists, after) => {
    const user = person();
    const { addOn } = await openPlace({ lists });
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    const approve = asksFirst(addOn!, SECRET);
    await user.click(bookmark());
    await screen.findByText(copy.saved.saving);
    // Said politely, under the page's header, as wide as the page: not in the row with the bookmark.
    const status = saying(copy.saved.saving)!;
    expect(status).not.toBeNull();
    const header = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(header.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bookmark(copy.saved.saving).parentElement).not.toContainElement(status);
    expect(tryAgain()).not.toBeInTheDocument();
    // The bookmark is as it was.
    expect(bookmark(copy.saved.saving)).toHaveAttribute("aria-pressed", "false");
    expect(drawn(bookmark(copy.saved.saving))).toBe("outlined");

    await approve.yes();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByText(copy.saved.saving)).not.toBeInTheDocument();
    // What the change left to say, if anything, is said in the same status.
    if (after === undefined) expect(status).toHaveTextContent(/^$/);
    else expect(saying(after)).toBe(status);
    expect(addOn!.signEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the list couldn't be loaded", copy.saved.notLoaded, (w: World) => setDown(w, true), (w: World) => setDown(w, false), {}],
    [
      "the person's add-on said no",
      copy.saved.notApproved,
      (_: World, addOn: AddOn) => void addOn.signEvent.mockRejectedValueOnce(new Error("The person said no")),
      () => {},
      {},
    ],
    ["no relay took it", copy.saved.notSaved, () => {}, () => {}, { writes: { answers: [{ refuse: "blocked: not now" }] } }],
  ] as const)("says so under the page's header when %s, with Try again, which saves it, the focus on the bookmark", async (_, line, breakIt, mendIt, relays) => {
    const user = person();
    const { w, addOn } = await openPlace({ relays });
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    breakIt(w, addOn!);
    await user.click(bookmark());
    await screen.findByText(line);
    expect(bookmark()).toHaveAttribute("aria-pressed", "false");
    // Said politely, under the page's header, as wide as the page: not in the row with the bookmark.
    const status = saying(line)!;
    expect(status).not.toBeNull();
    const header = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(header.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bookmark().parentElement).not.toContainElement(status);
    expect(tryAgain()).toHaveAttribute("aria-describedby", screen.getByText(line).id);
    // Nothing was saved: no relay holds a list.
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toBeUndefined();

    mendIt(w);
    await user.click(tryAgain()!);
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "true"));
    expect(tryAgain()).not.toBeInTheDocument();
    expect(screen.queryByText(line)).not.toBeInTheDocument();
    expect(bookmark()).toHaveFocus();
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([JACAFE.address]);
  });

  it("says a first save makes the list public, with the way to Saved; a save onto a list with a place in it says nothing", async () => {
    const user = person();
    const { router } = await openPlace();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    await user.click(bookmark());
    await screen.findByText(copy.saved.firstSave);
    expect(saying(copy.saved.firstSave)).not.toBeNull();
    const toSaved = screen.getByRole("link", { name: copy.saved.seeSaved });
    expect(toSaved).toHaveAttribute("href", "/saved");
    expect(toSaved).toHaveAttribute("aria-describedby", screen.getByText(copy.saved.firstSave).id);
    expect(tryAgain()).not.toBeInTheDocument();

    await user.click(toSaved);
    expect(router.state.location.pathname).toBe("/saved");
  });

  it("says nothing under it after a save onto a list with a place in it already", async () => {
    const user = person();
    const { w } = await openPlace({ lists: [savedList(ANOTHER_PLACE.address)] });
    await waitFor(() => expect(w.asked().filter(asksForSaved)).toHaveLength(SAVED_RELAYS.length));
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    await user.click(bookmark());
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByText(copy.saved.firstSave)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.saved.seeSaved })).not.toBeInTheDocument();
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([ANOTHER_PLACE.address, JACAFE.address]);
  });

  it("lets go of what it said once the person goes to another page, and back", async () => {
    const user = person();
    const { router, addOn } = await openPlace();
    await waitFor(() => expect(bookmark()).toHaveAttribute("aria-pressed", "false"));

    addOn!.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    await user.click(bookmark());
    await screen.findByText(copy.saved.notApproved);

    await act(() => router.navigate("/"));
    await act(() => router.navigate(PLACE_PATH));
    await screen.findByRole("heading", { level: 1, name: JACAFE.name });
    expect(screen.queryByText(copy.saved.notApproved)).not.toBeInTheDocument();
    expect(tryAgain()).not.toBeInTheDocument();
  });
});

describe("Save in the desktop's rail", () => {
  it("is the word, last among the rail's actions: Save, outlined, and Saved, filled, as a toggle named Save in either state", async () => {
    const user = person();
    const { w } = await openPlace({ px: DESKTOP, lists: [savedList(JACAFE.address)] });

    // Saved to see, and to a screen reader Save, pressed.
    const saved = await rail().findByRole("button", { name: copy.saved.save, pressed: true });
    expect(saved).toHaveAttribute("aria-pressed", "true");
    expect(saved.textContent).toBe(copy.saved.saved);
    expect(saved).toHaveClass("bg-emphasis", "text-on-emphasis");
    expect(saved.parentElement!.lastElementChild).toBe(saved);
    expect(saved.parentElement!.children).toHaveLength(4);

    await user.click(saved);
    const save = await rail().findByRole("button", { name: copy.saved.save, pressed: false });
    expect(save).toBe(saved);
    expect(save).toHaveAttribute("aria-pressed", "false");
    expect(save.textContent).toBe(copy.saved.save);
    expect(save).toHaveClass("border-ink", "text-ink");
    expect(save).not.toHaveClass("bg-emphasis");
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([]);
  });

  it("says Saving… in place of the word while the change is made, and can't be pressed again", async () => {
    const user = person();
    const { addOn } = await openPlace({ px: DESKTOP });
    const save = await rail().findByRole("button", { name: copy.saved.save, pressed: false });

    const approve = asksFirst(addOn!, SECRET);
    await user.click(save);
    expect(await rail().findByRole("button", { name: copy.saved.saving })).toBe(save);
    expect(save.textContent).toBe(copy.saved.saving);
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAttribute("aria-pressed", "false");
    await user.click(save);

    await approve.yes();
    expect(await rail().findByRole("button", { name: copy.saved.save, pressed: true })).toBe(save);
    expect(save.textContent).toBe(copy.saved.saved);
    expect(addOn!.signEvent).toHaveBeenCalledTimes(1);
  });

  it("says what went wrong under the row of actions, as wide as the rail, with Try again", async () => {
    const user = person();
    const { addOn } = await openPlace({ px: DESKTOP });
    const save = await rail().findByRole("button", { name: copy.saved.save, pressed: false });

    addOn!.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    await user.click(save);
    const line = await rail().findByText(copy.saved.notApproved);
    // Not in the row of actions: under it.
    expect(save.parentElement).not.toContainElement(line);
    expect(save.parentElement!.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(rail().getByRole("button", { name: copy.saved.tryAgain }));
    expect(await rail().findByRole("button", { name: copy.saved.save, pressed: true })).toBe(save);
    expect(save.textContent).toBe(copy.saved.saved);
    expect(save).toHaveFocus();
  });
});

describe("while saving is not open", () => {
  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("has no Save on %s for someone signed in, and reads no list", async (_, px) => {
    config.features.saved = false;
    const { w } = await openPlace({ px });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("button", { name: copy.saved.save })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.place.save })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.place.saveShort)).not.toBeInTheDocument();
    expect(w.asked().filter(asksForSaved)).toEqual([]);
  });
});
