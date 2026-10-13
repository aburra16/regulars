import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { type JSX, type ReactNode, StrictMode } from "react";
import { createMemoryRouter, MemoryRouter, type NavigateFunction, RouterProvider, useNavigate } from "react-router-dom";
import { expect, vi } from "vitest";

import { AccountProvider, useAccount, useConnect } from "../../src/account/AccountProvider";
import { SESSION_KEY } from "../../src/account/session";
import { CircleProvider, ForgetCircleOnSignOut } from "../../src/circle/CircleProvider";
import { FollowProvider, type OwnFollowed, useClearFollowLinesOnLeave, useFollow, useOwnFollowed } from "../../src/follow/FollowProvider";
import { HereProvider } from "../../src/location/HereProvider";
import { PlacesProvider } from "../../src/places/store";
import { ScoresProvider } from "../../src/score/ScoresProvider";
import { type Chrome, Shell } from "../../src/shell/Shell";
import type { World } from "./followWorld";
import { createMemoryReader } from "./memoryReader";

/*
 * A page for the tests of the session's own follow list (src/follow/FollowProvider.tsx): the
 * providers as main.tsx has them, the person and their add-on, and a plain button's part for each
 * person a test names, which says in words what `useFollow` gives and has its four taps. It is at
 * an address, and can go to another (`goTo`), with the buttons a test gives it on each. It reads and
 * writes the relays of a test's world (./followWorld.ts). Nothing opens a socket.
 */

/** Something a test holds shut until it opens it. */
export function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open: () => act(async () => open()) };
}

// ---------------------------------------------------------------------------------------------
// The person, and their add-on.
// ---------------------------------------------------------------------------------------------

/** The browser add-on (NIP-07) as a page sees it, signing with `key`. */
export function installAddOn(key: Uint8Array) {
  const addOn = {
    getPublicKey: vi.fn(async () => getPublicKey(key)),
    signEvent: vi.fn(async (template: EventTemplate): Promise<NostrEvent> => finalizeEvent(template, key)),
  };
  Object.defineProperty(window, "nostr", { configurable: true, writable: true, value: addOn });
  return addOn;
}
export type AddOn = ReturnType<typeof installAddOn>;

/** The person whose key is `key`, signed in with this browser in this tab before the page was opened. */
export function signedInAs(key: Uint8Array): AddOn {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey: getPublicKey(key) }));
  return installAddOn(key);
}

/** The add-on, which signs with `key`, asks the person before it signs the next thing, and waits: `yes` is their answer. */
export function asksFirst(addOn: AddOn, key: Uint8Array) {
  const asked = gate();
  addOn.signEvent.mockImplementationOnce(async (template) => {
    await asked.closed;
    return finalizeEvent(template, key);
  });
  return { yes: asked.open };
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

/**
 * A button's part of a page: what `useFollow` gives for `who`, in words, and its taps: the four that
 * ask for a change, and the two answers to being asked about a copy (`use`, `not now`). While the
 * person is asked, the words say so, with when the copy was last changed (`asking:<seconds>`).
 */
export function Person({ name, who }: { name: string; who: string }): JSX.Element {
  const of = useFollow(who);
  const words = [
    of.state,
    of.trouble === null ? "" : `trouble:${of.trouble}`,
    of.canUndo ? "undo" : "",
    of.justFollowed ? "just" : "",
    of.asking === null ? "" : `asking:${of.asking.changed}`,
  ];
  return (
    <>
      <output data-testid={name}>{words.filter(Boolean).join(" ")}</output>
      <button type="button" onClick={of.follow}>{`follow ${name}`}</button>
      <button type="button" onClick={of.unfollow}>{`unfollow ${name}`}</button>
      <button type="button" onClick={of.undo}>{`undo ${name}`}</button>
      <button type="button" onClick={of.retry}>{`retry ${name}`}</button>
      <button type="button" onClick={() => of.useThisCopy()}>{`use ${name}`}</button>
      <button type="button" onClick={of.notNow}>{`not now ${name}`}</button>
    </>
  );
}

let followedSeen: readonly string[] | null | undefined;
let ownedSeen: OwnFollowed | null | undefined;

/** The part of a page that lists who is followed: it keeps what `useOwnFollowed` gives, for `ownedNow`, and who that says is followed, for `followedNow`. */
export function Followed(): null {
  ownedSeen = useOwnFollowed();
  followedSeen = ownedSeen?.followed ?? null;
  return null;
}

/** Who was followed, as `useOwnFollowed` gave it when a page that lists who is followed was last drawn (null while the list was not known); undefined when none has been since `forgetFollowedSeen`. */
export const followedNow = (): readonly string[] | null | undefined => followedSeen;

/** What `useOwnFollowed` gave at that same drawing: the list, with whose it is. */
export const ownedNow = (): OwnFollowed | null | undefined => ownedSeen;

/** Forgets what `followedNow` and `ownedNow` give: for the start of a test. */
export function forgetFollowedSeen(): void {
  followedSeen = undefined;
  ownedSeen = undefined;
}

let navigate: NavigateFunction | undefined;

/**
 * The shell's part of a page: it tells the provider when the person has gone to another page, with
 * the hook the shell itself calls (src/shell/Shell.tsx), and keeps the way to one for `goTo`.
 */
function Visit(): null {
  useClearFollowLinesOnLeave();
  navigate = useNavigate();
  return null;
}

/** The person goes to the page at `to`, an address in the app. Its buttons are those the test's page has, as when two pages show the same people. */
export const goTo = (to: string) => act(() => void navigate!(to));

export interface PageOptions {
  /** Renders in React's strict mode, as main.tsx does. Default: no. */
  strict?: boolean;
  /** Whether the page lists who is followed (`useOwnFollowed`). Default: no. */
  lists?: boolean;
}

/**
 * The providers as main.tsx has them around a page, and a page with a button for each of `people`,
 * by a name of the test's. The page is inside a router and the provider outside it, as in the app.
 */
function tree(w: World, people: Record<string, string>, { strict = false, lists = false }: PageOptions): JSX.Element {
  const app = (
    <PlacesProvider reader={createMemoryReader([])}>
      <ScoresProvider readers={w.readers} writers={w.writers}>
        <AccountProvider>
          <FollowProvider>
            <MemoryRouter>
              <Visit />
              <Session />
              {Object.entries(people).map(([name, who]) => (
                <Person key={name} name={name} who={who} />
              ))}
              {lists ? <Followed /> : null}
            </MemoryRouter>
          </FollowProvider>
        </AccountProvider>
      </ScoresProvider>
    </PlacesProvider>
  );
  return strict ? <StrictMode>{app}</StrictMode> : app;
}

/** Opens the page over the relays of `w`. `show` draws it again with other buttons: one whose name is gone has left the page. */
export function open(w: World, people: Record<string, string>, opts: PageOptions = {}) {
  const view = render(tree(w, people, opts));
  return { ...view, show: (next: Record<string, string>) => view.rerender(tree(w, next, opts)) };
}

/** The public key of the person signed in, as the page says it; "nobody" when nobody is. */
export const signedInNow = () => screen.getByTestId("account").textContent;

/** The public key of the person this tab kept (`signedInAs`); undefined when it kept nobody. */
const keptPerson = () => (JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "{}") as { pubkey?: string }).pubkey;

/** Opens the page, and waits until the person this tab kept (`signedInAs`) is signed in. */
export async function openSignedIn(w: World, people: Record<string, string>, opts: PageOptions = {}) {
  const kept = keptPerson();
  const page = open(w, people, opts);
  await waitFor(() => expect(signedInNow()).toBe(kept));
  return page;
}

/**
 * Opens `page`, with who is signed in and Sign out beside it, inside the app's own shell
 * (src/shell/Shell.tsx), with every provider main.tsx has around it, at an address that shows no
 * places: what the shell does for a page (its door to My circle, its bar, what it tells the follow
 * list's provider) is the shell's own doing. Every address shows the same page; `goTo` takes the
 * person to another. `around` goes around the router, inside the providers: a circle of the test's
 * own, say. Waits until the person this tab kept (`signedInAs`) is signed in, or, when it kept
 * nobody, until the page says nobody is.
 */
export async function openPageInShell(w: World, page: ReactNode, around: (app: JSX.Element) => JSX.Element = (app) => app) {
  const kept = keptPerson();
  const shows: Chrome = { needsPlaces: false };
  const router = createMemoryRouter([
    {
      element: <Shell />,
      children: [
        {
          path: "*",
          handle: shows,
          element: (
            <>
              <Session />
              {page}
            </>
          ),
        },
      ],
    },
  ]);
  const view = render(
    <PlacesProvider reader={createMemoryReader([])}>
      <ScoresProvider readers={w.readers} writers={w.writers}>
        <ForgetCircleOnSignOut>
          <AccountProvider>
            <FollowProvider>
              <CircleProvider>
                <HereProvider>{around(<RouterProvider router={router} />)}</HereProvider>
              </CircleProvider>
            </FollowProvider>
          </AccountProvider>
        </ForgetCircleOnSignOut>
      </ScoresProvider>
    </PlacesProvider>,
  );
  await waitFor(() => expect(signedInNow()).toBe(kept ?? "nobody"));
  return { ...view, router, goTo: (to: string) => act(() => router.navigate(to)) };
}

/**
 * Opens a page with a button's part for each of `people` (`Person`) inside the app's own shell
 * (`openPageInShell`). `goTo` takes the person to another address, where the same buttons are.
 */
export const openInShell = (w: World, people: Record<string, string>) =>
  openPageInShell(
    w,
    Object.entries(people).map(([name, who]) => <Person key={name} name={name} who={who} />),
  );

/** What the button named `name` is told. */
export const says = (name: string) => screen.getByTestId(name).textContent;

/** A tap on one of the button's four, or on one of the two answers to being asked about a copy. */
export const tap = (name: string, what: "follow" | "unfollow" | "undo" | "retry" | "use" | "not now") =>
  fireEvent.click(screen.getByRole("button", { name: `${what} ${name}` }));

/** A tap on Sign out, or on signing in with the add-on as it is now. */
export const tapSession = (what: "sign out" | "sign in") => fireEvent.click(screen.getByRole("button", { name: what }));

/** Moves the fake clock on, and lets what was waiting on it run. */
export const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Lets everything that can go on without the clock go on: several turns of the event loop. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await act(() => new Promise<void>((done) => setImmediate(done)));
}
