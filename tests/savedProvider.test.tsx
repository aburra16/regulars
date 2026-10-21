import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { type JSX, StrictMode } from "react";
import { MemoryRouter, type NavigateFunction, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountProvider, useAccount, useConnect } from "../src/account/AccountProvider";
import { config } from "../src/config";
import type { Readers, RelayReader } from "../src/nostr/events";
import { PlacesProvider, TOWNS_WAIT_MS } from "../src/places/store";
import { belowSavedFloor, forgetSavedFloor } from "../src/saved/change";
import { SavedProvider, useClearSavedLinesOnLeave, useSaved, useSavedList } from "../src/saved/SavedProvider";
import { ScoresProvider } from "../src/score/ScoresProvider";
import { type AddOn, asksFirst, gate, installAddOn, settle, signedInAs, signedInNow, tapSession } from "./support/followPage";
import { asksForRelayList, OWN, relay, strangers, type World } from "./support/followWorld";
import { createMemoryReader } from "./support/memoryReader";
import { asksForSaved, SAVED_RELAYS, savedWorld, setUpSavedRelays } from "./support/savedWorld";

/*
 * The saved places of the person signed in, for the screens: `SavedProvider`, and the hooks
 * `useSaved` (a Save button's) and `useSavedList` (the Saved page's). It reads the list once the
 * person is signed in, and never writes one: a press goes through `changeSaved`
 * (tests/savedChange.test.ts holds that to its safeguards). These hold the provider to when it
 * reads, to what a read that cannot tell shows, to a change's list showing at once and the newer of
 * it and the next read standing, to what a change left to say being the place's for the page's
 * visit, and to sign-out letting go of everything of the person before. Relays are held in memory,
 * the keys are thrown away, and nothing opens a socket.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();
const OTHER = getPublicKey(OTHER_SECRET);

/** The address of a place of the list the app shows: the house's, with `d`. */
const placeAt = (d: string) => `39999:${config.houseHex}:${d}`;
const CAFE = placeAt("cafe-funchal");
const BAR = placeAt("bar-funchal");
const TEA = placeAt("tea-funchal");
/** A place's entry in a list, as a save writes it. */
const entry = (address: string) => ["a", address, config.placesRelay];
/** Another app's entry in the same record: no place. */
const THEIRS = ["a", `30023:${OTHER}:a-long-post`, "wss://writing.example.com"];

/** When the lists the relays hold before a test begins were made, in seconds. */
const LONG_AGO = 1_700_000_000;

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** A list of the person's saved places, truly signed: its name, its title and `tags`, made at `at`. */
const savedList = (tags: string[][], at = LONG_AGO): NostrEvent =>
  asSent(finalizeEvent({ kind: 30003, created_at: at, tags: [["d", "regulars-saved"], ["title", "Saved places"], ...tags], content: "" }, SECRET));

/** How many times each saved-list relay was asked for a saved list, in their order. */
const savedReads = (w: World) => SAVED_RELAYS.map((url) => w.relays[url]!.asked.filter(asksForSaved).length);

/** The places the newest saved list on the relay at `url` holds. */
const placesOn = (w: World, url: string) =>
  w.relays[url]!.held.filter((event) => event.kind === 30003)
    .sort((a, b) => b.created_at - a.created_at)[0]!
    .tags.filter((tag) => tag[0] === "a" && tag[1]!.startsWith("39999:"))
    .map((tag) => tag[1]);

/** Makes every saved-list relay hold `events`, and nothing else. */
function nowHolding(w: World, events: NostrEvent[]): void {
  for (const url of SAVED_RELAYS) w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, ...events);
}

/** Makes the first `count` of the saved-list relays fail every read, or answer again. */
function setDown(w: World, down: boolean, count: number = SAVED_RELAYS.length): void {
  for (const url of SAVED_RELAYS.slice(0, count)) w.relays[url]!.down = down;
}

/**
 * The readers of `w`, with a way to hold their answers to requests for a saved list: from `hold()`
 * until the gate it gives is opened, when the relays are asked what they hold then; with
 * `afterAWrite`, only the requests made once a relay has been sent a list. `asked` counts the
 * requests for a saved list each saved-list relay was handed, held or not, in their order.
 */
function holdable(w: World) {
  let held: { closed: Promise<void>; afterAWrite: boolean } | undefined;
  const handed = new Map<string, number>();
  const readers: Readers = (url) => {
    const reader = w.readers(url);
    return {
      async *req(filter, signal) {
        if (asksForSaved(filter)) {
          handed.set(url, (handed.get(url) ?? 0) + 1);
          if (held !== undefined && (!held.afterAWrite || w.published().length > 0)) await held.closed;
        }
        yield* reader.req(filter, signal);
      },
    } satisfies RelayReader;
  };
  return {
    readers,
    asked: () => SAVED_RELAYS.map((url) => handed.get(url) ?? 0),
    hold({ afterAWrite = false } = {}) {
      const answer = gate();
      held = { closed: answer.closed, afterAWrite };
      return {
        open: async () => {
          held = undefined;
          await answer.open();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

/** Who is signed in, with Sign out, and signing in with the add-on as it is now. */
function Session(): JSX.Element {
  const { account, signOut } = useAccount();
  const connect = useConnect();
  return (
    <>
      <output data-testid="account">{account?.pubkey ?? "nobody"}</output>
      <button type="button" onClick={signOut}>
        sign out
      </button>
      <button type="button" onClick={() => void connect.browser(new AbortController().signal)}>
        sign in
      </button>
    </>
  );
}

/** A Save button's part of a page, for the place at `address`: what `useSaved` gives, in words, and its two presses. */
function Place({ name, address }: { name: string; address: string }): JSX.Element {
  const of = useSaved({ address });
  return (
    <>
      <output data-testid={name}>{[of.state, of.line ?? ""].filter(Boolean).join(" ")}</output>
      <button type="button" onClick={of.press}>{`press ${name}`}</button>
      <button type="button" onClick={of.retry}>{`retry ${name}`}</button>
    </>
  );
}

/** The Saved page's part: what `useSavedList` gives, in words (the status, then each address), Try again, and Remove from list for the café. */
function List(): JSX.Element {
  const list = useSavedList();
  return (
    <>
      <output data-testid="list">{[list.status, ...list.addresses].join(" ")}</output>
      <button type="button" onClick={list.retry}>
        read again
      </button>
      <button type="button" onClick={() => list.remove(CAFE)}>
        remove cafe
      </button>
    </>
  );
}

let navigate: NavigateFunction | undefined;

/** The shell's part of a page: it tells the provider when the person has gone to another page, and keeps the way to one for `goTo`. */
function Visit(): null {
  useClearSavedLinesOnLeave();
  navigate = useNavigate();
  return null;
}

/** The person goes to the page at `to`, an address in the app. */
const goTo = (to: string) => act(() => void navigate!(to));

/**
 * The providers as main.tsx has them around a page with a Save button's part for the café and for
 * the bar, and the Saved page's part, inside a router at the café's page. It reads and writes the
 * relays of `w`, reading through `readers` when they are given.
 */
function open(w: World, { strict = false, readers = w.readers }: { strict?: boolean; readers?: Readers } = {}) {
  const app = (
    <PlacesProvider reader={createMemoryReader([])}>
      <ScoresProvider readers={readers} writers={w.writers}>
        <AccountProvider>
          <SavedProvider>
            <MemoryRouter initialEntries={["/place/cafe-funchal"]}>
              <Visit />
              <Session />
              <List />
              <Place name="cafe" address={CAFE} />
              <Place name="bar" address={BAR} />
            </MemoryRouter>
          </SavedProvider>
        </AccountProvider>
      </ScoresProvider>
    </PlacesProvider>
  );
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}

/** Opens the page, and waits until the person this tab kept (`signedInAs`) is signed in. */
async function openSignedIn(w: World, opts: Parameters<typeof open>[1] = {}) {
  const page = open(w, opts);
  await waitFor(() => expect(signedInNow()).toBe(ME));
  return page;
}

/** What the part named `name` is told: a place's state and line, or the list's status and addresses. */
const says = (name: string) => screen.getByTestId(name).textContent;

/** A press on one of the page's buttons, by its words. */
const press = (words: string) => fireEvent.click(screen.getByRole("button", { name: words }));

/** What the app logs: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  config.features.saved = true;
  setUpSavedRelays(config);
  // The scores store reads nothing of its own here: every read these see is the saved list's.
  config.houseTrustRelays = [];
  strangers.length = 0;
  // Each test starts as a tab just opened: no list seen yet.
  forgetSavedFloor();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    // The app goes away: every change and read under way is stopped, and no timer of theirs is left.
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "nostr");
    window.sessionStorage.clear();
  }
});

// ---------------------------------------------------------------------------------------------

describe("reading the person's saved places", () => {
  it("reads nothing while nobody is signed in, and the list once after sign-in, writing nothing", async () => {
    const w = savedWorld([savedList([entry(CAFE)])]);
    const addOn = installAddOn(SECRET);

    open(w);
    await settle();
    expect(says("list")).toBe("signed-out");
    expect(says("cafe")).toBe("save");
    expect(w.asked()).toEqual([]);

    tapSession("sign in");
    await waitFor(() => expect(says("list")).toBe(`ready ${CAFE}`));
    expect(says("cafe")).toBe("saved");
    expect(says("bar")).toBe("save");
    await settle();
    expect(savedReads(w)).toEqual([1, 1, 1, 1, 1]);
    // Read, and nothing written: nothing was signed, and no relay was sent anything.
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is read once a session this tab kept is restored, once in React's strict mode, and says Save of every place until then", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    const relays = holdable(w);
    const answer = relays.hold();

    await openSignedIn(w, { strict: true, readers: relays.readers });
    await waitFor(() => expect(relays.asked()).toEqual([1, 1, 1, 1, 1]));
    expect(says("list")).toBe("loading");
    expect(says("bar")).toBe("save");

    await answer.open();
    await waitFor(() => expect(says("bar")).toBe("saved"));
    await settle();
    expect(savedReads(w)).toEqual([1, 1, 1, 1, 1]);
  });

  it("says the list is loading while a session this tab kept is restored, and not that nobody is signed in", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);

    open(w);
    expect(signedInNow()).toBe("nobody");
    expect(says("list")).toBe("loading");
    await waitFor(() => expect(says("list")).toBe(`ready ${BAR}`));
  });

  it("is read from the relays the person's relay list names, with the app's, through the readers the scores' provider gives", async () => {
    signedInAs(SECRET);
    const relayList = asSent(finalizeEvent({ kind: 10002, created_at: LONG_AGO, tags: [["r", OWN, "write"]], content: "" }, SECRET));
    // Only the person's own relay holds their list.
    const w = savedWorld([], {}, { [OWN]: relay([savedList([entry(TEA)])]) }, [relayList]);

    await openSignedIn(w);

    await waitFor(() => expect(says("list")).toBe(`ready ${TEA}`));
    expect(w.relays[OWN]!.asked.filter(asksForSaved)).toHaveLength(1);
    expect(w.reviews.asked.every(asksForRelayList)).toBe(true);
  });

  it("names the places of the list the app shows, newest saved first, and nothing else the record holds", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE), THEIRS, ["e", "e".repeat(64)], entry(BAR)])]);

    await openSignedIn(w);

    await waitFor(() => expect(says("list")).toBe(`ready ${BAR} ${CAFE}`));
    expect(says("cafe")).toBe("saved");
    expect(says("bar")).toBe("saved");
  });

  it("knows the person has saved nothing when more than half of the app's relays answer with no list", async () => {
    signedInAs(SECRET);
    const w = savedWorld([]);
    setDown(w, true, 2);

    await openSignedIn(w);

    await waitFor(() => expect(says("list")).toBe("ready"));
    expect(says("cafe")).toBe("save");
  });

  it.each([
    ["no saved-list relay answers", 5],
    ["only two of the five answer, with no list", 3],
  ])("has failed when %s, says Save of every place, and Try again reads again", async (_, down) => {
    signedInAs(SECRET);
    const w = savedWorld([]);
    setDown(w, true, down);
    const relays = holdable(w);

    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(says("list")).toBe("failed"));
    expect(says("cafe")).toBe("save");

    setDown(w, false);
    nowHolding(w, [savedList([entry(CAFE)])]);
    const answer = relays.hold();
    press("read again");
    await waitFor(() => expect(says("list")).toBe("loading"));
    await answer.open();
    await waitFor(() => expect(says("list")).toBe(`ready ${CAFE}`));
    expect(says("cafe")).toBe("saved");
    expect(savedReads(w)).toEqual([2, 2, 2, 2, 2]);
    expect(w.published()).toEqual([]);
  });
});

describe("a change, and what the screens show after it", () => {
  it("shows the list a save made at once, with no wait for a read, and reads again after it", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    const relays = holdable(w);

    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(says("bar")).toBe("saved"));
    const after = relays.hold({ afterAWrite: true });

    press("press cafe");
    expect(says("cafe")).toBe("saving");
    await waitFor(() => expect(says("cafe")).toBe("saved"));
    expect(says("list")).toBe(`ready ${CAFE} ${BAR}`);
    // Read once at sign-in, once by the change, and once after it: that last has not answered.
    await waitFor(() => expect(relays.asked()).toEqual([3, 3, 3, 3, 3]));
    expect(savedReads(w)).toEqual([2, 2, 2, 2, 2]);

    await after.open();
    await settle();
    expect(says("list")).toBe(`ready ${CAFE} ${BAR}`);
  });

  it("keeps the list a save made when the read after it finds only an older one", async () => {
    signedInAs(SECRET);
    const old = savedList([entry(BAR)]);
    const w = savedWorld([old]);
    const relays = holdable(w);

    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(says("bar")).toBe("saved"));
    const after = relays.hold({ afterAWrite: true });
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved"));

    // The relays answer the read after it with the list before the save, as relays that lost it would.
    nowHolding(w, [old]);
    await after.open();
    await settle();
    expect(says("list")).toBe(`ready ${CAFE} ${BAR}`);
    expect(says("cafe")).toBe("saved");
  });

  it("shows a newer list than the one a save made when the read after it finds one, saved meanwhile elsewhere", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    const relays = holdable(w);

    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(says("bar")).toBe("saved"));
    const after = relays.hold({ afterAWrite: true });
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved"));

    const written = w.relays[SAVED_RELAYS[0]]!.writer.published[0]!;
    nowHolding(w, [savedList([entry(BAR), entry(CAFE), entry(TEA)], written.created_at + 10)]);
    await after.open();
    await waitFor(() => expect(says("list")).toBe(`ready ${TEA} ${CAFE} ${BAR}`));
  });

  it("takes a saved place out on a press, and on Remove from list", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE), entry(BAR)])]);

    await openSignedIn(w);
    await waitFor(() => expect(says("list")).toBe(`ready ${BAR} ${CAFE}`));

    press("press bar");
    await waitFor(() => expect(says("bar")).toBe("save"));
    expect(says("list")).toBe(`ready ${CAFE}`);
    press("remove cafe");
    await waitFor(() => expect(says("list")).toBe("ready"));
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([]);
  });

  it("shows Saved for a place a press finds in the list already, before the list was read, and writes nothing", async () => {
    const addOn = signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE)])]);
    const relays = holdable(w);
    const answer = relays.hold();

    await openSignedIn(w, { readers: relays.readers });
    expect(says("cafe")).toBe("save");
    press("press cafe");
    expect(says("cafe")).toBe("saving");
    await answer.open();

    await waitFor(() => expect(says("cafe")).toBe("saved"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("says a save that put the first place in the list is a first save, and a save onto a list with a place in it is not", async () => {
    signedInAs(SECRET);
    // Another app's entry, and no place: the person has saved no place.
    const w = savedWorld([savedList([THEIRS])]);

    await openSignedIn(w);
    await waitFor(() => expect(says("list")).toBe("ready"));

    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved first-save"));
    press("press bar");
    await waitFor(() => expect(says("bar")).toBe("saved"));
  });

  it("says a first save of a person with no list at all is one", async () => {
    signedInAs(SECRET);
    const w = savedWorld([]);

    await openSignedIn(w);
    await waitFor(() => expect(says("list")).toBe("ready"));

    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved first-save"));
    expect(says("list")).toBe(`ready ${CAFE}`);
  });

  it.each([
    ["not-loaded", (w: World) => setDown(w, true), (w: World) => setDown(w, false)],
    ["not-approved", (_: World, addOn: AddOn) => void addOn.signEvent.mockRejectedValueOnce(new Error("The person said no")), () => {}],
  ] as const)("says %s of a save that was not made, and Try again makes it", async (line, breakIt, mendIt) => {
    const addOn = signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    await openSignedIn(w);
    await waitFor(() => expect(says("bar")).toBe("saved"));

    breakIt(w, addOn);
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe(`save ${line}`));
    expect(w.published()).toEqual([]);

    mendIt(w);
    press("retry cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved"));
    expect(says("list")).toBe(`ready ${CAFE} ${BAR}`);
  });

  it("says not-saved when no relay takes the list, and Try again makes the change that was not made", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE)])], { writes: { answers: [{ refuse: "blocked: not now" }] } });
    await openSignedIn(w);
    await waitFor(() => expect(says("cafe")).toBe("saved"));

    // An unsave that no relay took: the place is in the list still.
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("saved not-saved"));
    press("retry cafe");
    await waitFor(() => expect(says("cafe")).toBe("save"));
    for (const url of SAVED_RELAYS) expect(placesOn(w, url)).toEqual([]);
  });

  it("lets go of a line once the list has the place as the change meant, made elsewhere after all", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    await openSignedIn(w);
    await waitFor(() => expect(says("bar")).toBe("saved"));

    setDown(w, true);
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("save not-loaded"));

    // Saved in another app meanwhile: the next read finds it.
    setDown(w, false);
    nowHolding(w, [savedList([entry(BAR), entry(CAFE)], LONG_AGO + 10)]);
    press("read again");
    await waitFor(() => expect(says("cafe")).toBe("saved"));
  });

  it("makes one change to a place at a time: a press while one is under way does nothing", async () => {
    const addOn = signedInAs(SECRET);
    const w = savedWorld([]);
    await openSignedIn(w);
    await waitFor(() => expect(says("list")).toBe("ready"));

    const approve = asksFirst(addOn, SECRET);
    press("press cafe");
    expect(says("cafe")).toBe("saving");
    press("press cafe");
    press("remove cafe");
    await approve.yes();

    await waitFor(() => expect(says("cafe")).toBe("saved first-save"));
    await settle();
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(says("cafe")).toBe("saved first-save");
  });
});

describe("what a change left to say", () => {
  it("is for the page it was said on: a place's page and the form that reviews it are one, and any other page another", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(BAR)])]);
    await openSignedIn(w);
    await waitFor(() => expect(says("bar")).toBe("saved"));

    setDown(w, true);
    press("press cafe");
    await waitFor(() => expect(says("cafe")).toBe("save not-loaded"));

    await goTo("/place/cafe-funchal/review");
    expect(says("cafe")).toBe("save not-loaded");
    await goTo("/place/cafe-funchal");
    expect(says("cafe")).toBe("save not-loaded");
    await goTo("/");
    expect(says("cafe")).toBe("save");
    // Try again has nothing to make again once its line has gone.
    setDown(w, false);
    press("retry cafe");
    await settle();
    expect(says("cafe")).toBe("save");
    expect(w.published()).toEqual([]);
  });
});

describe("signing out", () => {
  it("lets go of the list and of what this tab saw of it, so the next person to sign in sees none of the first's", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE)])]);
    const relays = holdable(w);
    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(says("cafe")).toBe("saved"));
    expect(belowSavedFloor(ME, null)).toBe(true);

    tapSession("sign out");
    await waitFor(() => expect(says("list")).toBe("signed-out"));
    expect(says("cafe")).toBe("save");
    // What this tab saw of the list is forgotten.
    expect(belowSavedFloor(ME, null)).toBe(false);

    // Someone else signs in, whose list is read afresh: nothing of the first's is shown meanwhile.
    installAddOn(OTHER_SECRET);
    const answer = relays.hold();
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(OTHER));
    expect(says("list")).toBe("loading");
    expect(says("cafe")).toBe("save");
    await answer.open();
    await waitFor(() => expect(says("list")).toBe("ready"));
    expect(says("cafe")).toBe("save");
  });

  it("stops a read under way, and shows nothing of it", async () => {
    signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE)])]);
    const relays = holdable(w);
    const answer = relays.hold();
    await openSignedIn(w, { readers: relays.readers });
    await waitFor(() => expect(relays.asked()).toEqual([1, 1, 1, 1, 1]));

    tapSession("sign out");
    await waitFor(() => expect(says("list")).toBe("signed-out"));
    await answer.open();
    await settle();
    expect(says("list")).toBe("signed-out");
    expect(says("cafe")).toBe("save");
    expect(belowSavedFloor(ME, null)).toBe(false);
  });

  it("gives up a change under way: what the signer signs after is sent nowhere", async () => {
    const addOn = signedInAs(SECRET);
    const w = savedWorld([]);
    await openSignedIn(w);
    await waitFor(() => expect(says("list")).toBe("ready"));

    const approve = asksFirst(addOn, SECRET);
    press("press cafe");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    tapSession("sign out");
    await approve.yes();
    await settle();

    expect(w.published()).toEqual([]);
    expect(says("cafe")).toBe("save");
  });
});

describe("while saving is not open", () => {
  it("reads nothing, and a press changes nothing", async () => {
    config.features.saved = false;
    const addOn = signedInAs(SECRET);
    const w = savedWorld([savedList([entry(CAFE)])]);

    await openSignedIn(w);
    await settle();
    press("press cafe");
    press("read again");
    press("remove cafe");
    await settle();

    expect(w.asked().filter(asksForSaved)).toEqual([]);
    expect(says("cafe")).toBe("save");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});
