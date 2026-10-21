import type { NostrEvent } from "@nostrify/nostrify";
import { createContext, type JSX, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { isNewer } from "../nostr/events.ts";
import type { Place } from "../places/place.ts";
import { isFormOver } from "../review/paths.ts";
import { type Relays, useRelays } from "../score/ScoresProvider.tsx";
import { belowSavedFloor, changeSaved, forgetSavedFloor, raiseSavedFloor, type SavedOutcome } from "./change.ts";
import { savedAddresses } from "./list.ts";
import { mayStartList, readSavedList } from "./read.ts";

/*
 * The saved places of the person signed in, held for the tab so that every Save button and the Saved
 * page draw from one list: `SavedProvider`, and the hooks they use (`useSaved`, `useSavedList`). The
 * list is read once the person is signed in, or their session is restored, from the relays their
 * relay list names and the app's saved-list relays (`readSavedList`, ./read.ts), and kept in memory
 * only; it is read again after each change that saved a list, and on Try again. It is for what the
 * screens show and no more: a change is never built on it. A press goes to `changeSaved`
 * (./change.ts), which reads the list afresh itself, and what the screens show after comes from the
 * list that change saved or found, at once, with no wait for a read.
 *
 * Nothing here signs or sends (tests/savedGuard.test.ts holds this module to that): it reads, and it
 * calls `changeSaved` on a press of Save, Saved, Try again or Remove from list, and at no other time.
 * Not as a page opens, nor at sign-in or on the way back from it, nor after a read. Nothing here is
 * logged: a list, its entries and the relays a person keeps it on are theirs.
 *
 * No screen draws from a list older than one this tab has seen (the floor, ./change.ts). Every list a
 * read finds raises it, as every list a change saves does; a read whose newest list is older, or
 * that found none where one has been seen, has missed that list, and what is held stays. So of a
 * change's list and the read after it, the newer stands. A read that cannot tell (the person's relay
 * list could not be read, or too few of the app's relays answered, to know there is no list) holds
 * nothing, and the page says the list could not be loaded; a button then says Save, and a press reads
 * afresh for itself.
 *
 * Signing out, someone else signing in and the app going away each stop the read and every change
 * under way, and let go of the list and of what this tab saw of it (`forgetSavedFloor`): the next
 * person starts as in a tab just opened, and sees nothing of the one before.
 *
 * What a change left to say (that it was not made, or that it put the first place in the list, which
 * anyone can see) is held for the place, not for a button: the phone's and the rail's say the same.
 * It is let go of on the next press for that place, once the list held no longer agrees with it, and
 * when the person goes to another page (`useClearSavedLinesOnLeave`, which the shell calls). Try
 * again makes again the change that was not made, never the one the button's state would suggest.
 *
 * While saving is not open (`config.features.saved`) none of this happens: no list is read, nothing
 * is known of anyone, and a press is no change. The store holds itself to that (`#live`).
 */

/** What a Save button for a place says: `save` before the list is read and for a place not in it; `saved` for one in it; `saving` while a change to it is under way. */
export type SavedState = "save" | "saved" | "saving";

/**
 * What a change to a place left to say, under its button:
 * - `not-loaded`, `not-approved`, `not-saved`: the change was not made (`SavedOutcome`), and Try again
 *   makes it again;
 * - `first-save`: a save put the first place in the person's list, which anyone can see.
 */
export type SavedLine = "not-loaded" | "not-approved" | "not-saved" | "first-save";

/** What `useSaved` gives a button for one place. */
export interface SavedOf {
  state: SavedState;
  /** What the last change to the place left to say; none from the next press, once the list no longer agrees with it, and once the person has left the page. */
  line?: SavedLine;
  /** Saves the place, or takes it out of the list while it is in it: for a press of the button. Nothing while a change to it is under way, or nobody is signed in. */
  press(): void;
  /** Makes again the change a line says was not made: for a press of Try again. Nothing when no such line is said. */
  retry(): void;
}

/** What `useSavedList` gives the Saved page. */
export interface SavedList {
  /**
   * - `signed-out`: nobody is signed in (or saving is not open);
   * - `loading`: a session this tab kept is being restored, or the list is being read;
   * - `failed`: the last read could not tell, and no list is held: the page says so, with Try again;
   * - `ready`: the list is known, from a read or a change.
   */
  status: "signed-out" | "loading" | "failed" | "ready";
  /** The places the list holds, newest saved first, each once (`savedAddresses`): empty until `ready`. The same array until the list changes. */
  addresses: readonly string[];
  /** Reads the list again: for a press of Try again. Nothing while a read is under way. */
  retry(): void;
  /** Takes the place at `address` out of the list, down the same path as a press: for a press of Remove from list. */
  remove(address: string): void;
}

/** What a change to a place was asked to do: put it in the list, or take it out. */
type Meant = "save" | "unsave";

/** What the session holds of one place a button was pressed for. */
interface Pressed {
  /** Whether a change to it is under way: from the press until the change has ended. */
  saving: boolean;
  /** What the last change to it left to say, with what that change was, for Try again; null when nothing. */
  line: { kind: SavedLine; meant: Meant } | null;
}

/** What is held for the person signed in, from their sign-in until they sign out or someone else signs in. */
interface Session {
  /** The person, with the signer their changes are signed with. */
  account: Account;
  /** Aborts when the session ends, and at no other time: the read of the list and every change are made on its signal. */
  stop: AbortController;
  /** Their list: undefined until a read or a change has found it, null once it is known that they have none. */
  list: NostrEvent | null | undefined;
  /** The places it holds, newest saved first: the same array until the list changes. */
  addresses: readonly string[];
  /** The same places, for a button's question of one. */
  holds: ReadonlySet<string>;
  /** Whether the list is being read. */
  reading: boolean;
  /** Whether it is read once more when the read under way ends: a change saved a list after that read began. */
  again: boolean;
  /** Whether the last read could not tell what the list is, and none is held. */
  failed: boolean;
  /** The places a button was pressed for, by address. */
  pressed: Map<string, Pressed>;
}

/** What a button is told while nothing is known: nobody is signed in, saving is not open, or there is no provider. */
const NOTHING_KNOWN: Pick<SavedOf, "state"> = { state: "save" };

/** What the page is told while nobody is signed in, or saving is not open. */
const SIGNED_OUT: Pick<SavedList, "status" | "addresses"> = { status: "signed-out", addresses: Object.freeze([]) };
/** What the page is told while the list is not known yet. */
const LOADING: Pick<SavedList, "status" | "addresses"> = { status: "loading", addresses: Object.freeze([]) };
/** What the page is told once a read could not tell. */
const FAILED: Pick<SavedList, "status" | "addresses"> = { status: "failed", addresses: Object.freeze([]) };

/**
 * The session's saved places, which `SavedProvider` holds for the hooks below. It reads the list once
 * someone is signed in, and makes each change a button or the page asks for, one at a time for each
 * place (`changeSaved` takes them in turn, across places too).
 */
class OwnSaved {
  readonly #relays: Relays;
  readonly #listeners = new Set<() => void>();
  /** Changes with anything a button or the page is told. */
  #version = 0;
  /** What is held for the person signed in; null while nobody is. */
  #session: Session | null = null;

  constructor(relays: Relays) {
    this.#relays = relays;
  }

  /**
   * The session, for whatever tells, reads or changes; none while saving is not open, whoever is
   * signed in. The one place that looks: nothing below reaches a relay, or tells a screen of a list,
   * but through it.
   */
  #live(): Session | null {
    return config.features.saved ? this.#session : null;
  }

  /** Calls `listener` after each change, and returns what stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A number that changes with anything a button or the page is told, for `useSyncExternalStore`. */
  readonly version = (): number => this.#version;

  /**
   * Who is signed in: `account`, or nobody. When it is someone else than before, or nobody, what was
   * held for the person before is let go of: their list, what their buttons were to say, and what
   * this tab saw of their list (`forgetSavedFloor`); the read and every change of theirs still under
   * way are stopped. The same person signed in anew keeps it. A new session's list is read once the
   * drawing that began it is over: React's strict mode ends a session and begins it again within
   * one drawing, and the session it ended reads nothing.
   */
  setAccount(account: Account | undefined): void {
    const session = this.#session;
    if (session !== null && session.account.pubkey === account?.pubkey) {
      session.account = account;
      return;
    }
    this.#end();
    if (account === undefined) return;
    const begun: Session = {
      account,
      stop: new AbortController(),
      list: undefined,
      addresses: Object.freeze([]),
      holds: new Set(),
      reading: false,
      again: false,
      failed: false,
      pressed: new Map(),
    };
    this.#session = begun;
    this.#changed();
    queueMicrotask(() => this.#read(begun));
  }

  /**
   * Whether the session is the one for `pubkey`, the person the screens are drawn for: the provider is
   * told of a new person only once the drawing that signed them in is over, and until then what is
   * held is the person's before, which is never drawn for another.
   */
  #liveFor(pubkey: string | undefined): Session | null {
    const session = this.#live();
    return session !== null && pubkey !== undefined && session.account.pubkey === pubkey ? session : null;
  }

  /** What a button for the place at `address` is told, drawn for the person `pubkey`: the same whichever button asks. */
  of(address: string, pubkey: string | undefined): Pick<SavedOf, "state" | "line"> {
    const session = this.#liveFor(pubkey);
    if (session === null) return NOTHING_KNOWN;
    const pressed = session.pressed.get(address);
    const state: SavedState = pressed?.saving === true ? "saving" : session.holds.has(address) ? "saved" : "save";
    const line = pressed?.line?.kind;
    return line === undefined ? { state } : { state, line };
  }

  /** What the page is told, drawn for the person `pubkey` (undefined: nobody is signed in, and `restoring` says whether someone is about to be). */
  list(pubkey: string | undefined, restoring: boolean): Pick<SavedList, "status" | "addresses"> {
    if (!config.features.saved) return SIGNED_OUT;
    if (pubkey === undefined) return restoring ? LOADING : SIGNED_OUT;
    const session = this.#liveFor(pubkey);
    if (session === null) return LOADING;
    if (session.list !== undefined) return { status: "ready", addresses: session.addresses };
    return session.failed && !session.reading ? FAILED : LOADING;
  }

  /**
   * Saves the place at `address`, or takes it out while the list holds it: for a press of its button,
   * drawn for the person `pubkey`. Each press below is for that person's session alone, as what the
   * button said was.
   */
  press(address: string, pubkey: string | undefined): void {
    const session = this.#liveFor(pubkey);
    if (session !== null) this.#start(session, address, session.holds.has(address) ? "unsave" : "save");
  }

  /**
   * Makes again the change to the place at `address` that a line says was not made: for a press of
   * Try again. It is the change that was asked for, kept with its line, and not what the list held
   * would make of a press now. Nothing when no such line is said of it.
   */
  retry(address: string, pubkey: string | undefined): void {
    const session = this.#liveFor(pubkey);
    const line = session?.pressed.get(address)?.line;
    if (session === null || line === undefined || line === null || line.kind === "first-save") return;
    this.#start(session, address, line.meant);
  }

  /** Takes the place at `address` out of the list: for a press of Remove from list. */
  remove(address: string, pubkey: string | undefined): void {
    const session = this.#liveFor(pubkey);
    if (session !== null) this.#start(session, address, "unsave");
  }

  /** Reads the list again: for a press of Try again on the page. Nothing while a read is under way. */
  reread(pubkey: string | undefined): void {
    const session = this.#liveFor(pubkey);
    if (session !== null && !session.reading) this.#read(session);
  }

  /**
   * The person has gone to another page. What a change left to say was for the page it was said on:
   * it is let go of, for every place. Not a change under way, whose end is told on the page the person
   * is on by then.
   */
  leftPage(): void {
    const session = this.#live();
    if (session === null) return;
    let said = false;
    for (const [address, pressed] of session.pressed) {
      if (pressed.saving) continue;
      if (pressed.line !== null) said = true;
      session.pressed.delete(address);
    }
    if (said) this.#changed();
  }

  /**
   * Starts a change to the place at `address`, unless one is under way. The change is `changeSaved`'s,
   * start to end, on the session's signal and no other: it aborts when the person signs out or
   * someone else signs in, and when the app goes away. Not when the change's button has gone, nor
   * when the person goes to another page: a change asked for is made.
   */
  #start(session: Session, address: string, meant: Meant): void {
    const pressed: Pressed = session.pressed.get(address) ?? { saving: false, line: null };
    session.pressed.set(address, pressed);
    if (pressed.saving) return;
    pressed.saving = true;
    pressed.line = null;
    this.#changed();
    const { readers, writers } = this.#relays;
    const change = meant === "save" ? { save: { address } } : { unsave: address };
    changeSaved(session.account, change, { readers, writers }, session.stop.signal).then(
      (outcome) => this.#over(session, address, pressed, meant, outcome),
      () => this.#over(session, address, pressed, meant, null),
    );
  }

  /**
   * A change to the place at `address` has ended: `outcome` is how, or null when it failed in a way
   * `changeSaved` has no name for. Nothing of it is kept when its session is over: it was given up.
   */
  #over(session: Session, address: string, pressed: Pressed, meant: Meant, outcome: SavedOutcome | null): void {
    if (this.#session !== session) return;
    pressed.saving = false;
    if (outcome === null) {
      // Not a change given up, as its session goes on. Nothing is sent once it fails so: not saved.
      pressed.line = { kind: "not-saved", meant };
    } else if (outcome.kind === "saved") {
      // What it saved is shown at once: no read waits on it. It is the newest list this tab knows of.
      this.#hold(session, outcome.list);
      // Built on a list that held no place: the place it saved is the only one. That is said, as the
      // list is anyone's to see. Known from the list itself, and from nothing kept on the device.
      const places = savedAddresses(outcome.list);
      if (meant === "save" && places.length === 1 && places[0] === address) pressed.line = { kind: "first-save", meant };
      // Read again: a newer list, saved meanwhile elsewhere, takes its place; an older one never does.
      this.#read(session);
    } else if (outcome.kind === "unchanged") {
      // The list was so already, as the change's own fresh read found it: that is what is shown.
      this.#hold(session, outcome.list);
    } else {
      pressed.line = { kind: outcome.kind, meant };
    }
    this.#agree(session);
    this.#changed();
  }

  /**
   * Reads the list of the session's person, unless saving is not open or the session has ended. While
   * a read is under way, the next is made once it has ended: one read at a time.
   */
  #read(session: Session): void {
    if (this.#live() !== session) return;
    if (session.reading) {
      session.again = true;
      return;
    }
    session.reading = true;
    session.again = false;
    this.#changed();
    void this.#readNow(session);
  }

  /**
   * One read of the list (`readSavedList`), from the person's relays and the app's. It only reads.
   * Every list it finds is one this tab has seen from then on (`raiseSavedFloor`), and is held when it
   * is the newest known; none at all is held as no list only when the person's relay list was read
   * and enough of the app's relays answered to say so (`mayStartList`). A read that found an older
   * list than one this tab has seen, or none where one has been seen, has missed it: what is held
   * stays, and with nothing held the read could not tell, as one with too few answers could not.
   */
  async #readNow(session: Session): Promise<void> {
    const { pubkey } = session.account;
    try {
      const read = await readSavedList(pubkey, this.#relays.readers, session.stop.signal);
      if (this.#session !== session) return;
      // A list of theirs, checked as theirs by the reader: no change is built on an older one.
      if (read.list !== null) raiseSavedFloor(pubkey, read.list);
      if (!belowSavedFloor(pubkey, read.list) && (read.list !== null || mayStartList(read))) {
        this.#hold(session, read.list);
        this.#agree(session);
      }
    } catch {
      // Stopped (the person signed out, or someone else signed in), or something unexpected went
      // wrong: a relay that fails or is slow is not thrown for. Nothing of it is kept.
    } finally {
      session.reading = false;
      if (session.list === undefined) session.failed = true;
      if (this.#session === session) {
        if (session.again) this.#read(session);
        else this.#changed();
      }
    }
  }

  /**
   * Holds `list` as the session's person's (null: they have none), unless a newer one is held: of two
   * lists, the newer stands, whichever came last. Whether what is held changed.
   */
  #hold(session: Session, list: NostrEvent | null): boolean {
    const held = session.list;
    if (held === null && list === null) return false;
    if (held !== undefined && held !== null && (list === null || !isNewer(list, held))) return false;
    session.list = list;
    session.failed = false;
    session.addresses = Object.freeze(savedAddresses(list));
    session.holds = new Set(session.addresses);
    return true;
  }

  /**
   * Lets go of what the list held no longer agrees with: a save that was not made of a place the list
   * holds, or an unsave that was not made of one it does not, was made after all, elsewhere; and a
   * first save's line is for a place that is still saved. Nothing while the list is not known.
   */
  #agree(session: Session): void {
    if (session.list === undefined) return;
    for (const [address, pressed] of session.pressed) {
      const { line } = pressed;
      if (line === null || pressed.saving) continue;
      const holds = session.holds.has(address);
      if (line.kind === "first-save" ? !holds : holds === (line.meant === "save")) pressed.line = null;
    }
  }

  /** Ends the session: stops what is under way for its person, and lets go of what was held for them. */
  #end(): void {
    const session = this.#session;
    if (session === null) return;
    this.#session = null;
    session.stop.abort(new DOMException("The person signed out, or someone else signed in", "AbortError"));
    // What this tab saw of their list is theirs: the next to sign in starts as in a tab just opened.
    forgetSavedFloor();
    this.#changed();
  }

  /** Notes a change to what a button or the page is told, and tells the listeners. */
  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

const SavedContext = createContext<OwnSaved | null>(null);

/**
 * Holds the saved places of the person signed in, for the buttons and the page below it (`useSaved`,
 * `useSavedList`). It must be inside the account provider, whose person it follows, and the scores
 * provider, whose readers and writers it uses (`useRelays`): the app's readers check each event's
 * signature, as a list is anyone's to write in a person's name. It reads the list once someone is
 * signed in, and writes nothing: a press goes through `changeSaved`. Signing out, someone else
 * signing in, and the app going away each stop what is under way and let go of what was held. While
 * saving is not open (`config.features.saved`) it reads nothing at all, and no press is a change.
 */
export function SavedProvider({ children }: { children: ReactNode }): JSX.Element {
  const { account } = useAccount();
  const relays = useRelays();
  const [store] = useState(() => new OwnSaved(relays));

  // Before the page is drawn, so that nothing is drawn from another person's list.
  useLayoutEffect(() => store.setAccount(account), [store, account]);
  // The app going away: what is under way is stopped.
  useLayoutEffect(() => () => store.setAccount(undefined), [store]);

  return <SavedContext value={store}>{children}</SavedContext>;
}

/** For a tree with no `SavedProvider`: nothing to listen to. */
const listenToNothing = () => () => {};
const noVersion = () => 0;

/**
 * Whether the person signed in has saved `place`, for its Save button, with the presses that change
 * it. Until their list is read, and when it could not be, the state is `save`: a press is still a
 * change, which reads the list itself, and shows Saved when it finds the place there already. When
 * nobody is signed in, or there is no `SavedProvider` above, the state is `save` and the presses do
 * nothing.
 */
export function useSaved(place: Pick<Place, "address">): SavedOf {
  const store = useContext(SavedContext);
  const pubkey = useAccount().account?.pubkey;
  const version = useSyncExternalStore(store?.subscribe ?? listenToNothing, store?.version ?? noVersion);
  const { address } = place;

  const presses = useMemo(
    () => ({
      press: () => store?.press(address, pubkey),
      retry: () => store?.retry(address, pubkey),
    }),
    [store, address, pubkey],
  );

  return useMemo(() => {
    void version; // What the store tells changes with it.
    const told = store === null ? NOTHING_KNOWN : store.of(address, pubkey);
    return { ...told, ...presses };
  }, [store, address, pubkey, version, presses]);
}

/**
 * The saved places of the person signed in, for the Saved page: whether they are known, the places
 * newest saved first, Try again for a read that could not tell, and Remove from list. Nothing of
 * another person's is ever given: the list is told for the person the page is drawn for, and is
 * loading for anyone else until the provider has been told of them.
 */
export function useSavedList(): SavedList {
  const store = useContext(SavedContext);
  const { account, restoring } = useAccount();
  const pubkey = account?.pubkey;
  const version = useSyncExternalStore(store?.subscribe ?? listenToNothing, store?.version ?? noVersion);

  const presses = useMemo(
    () => ({
      retry: () => store?.reread(pubkey),
      remove: (address: string) => store?.remove(address, pubkey),
    }),
    [store, pubkey],
  );

  return useMemo(() => {
    void version; // What the store tells changes with it.
    const told = store === null ? SIGNED_OUT : store.list(pubkey, restoring);
    return { ...told, ...presses };
  }, [store, pubkey, restoring, version, presses]);
}

/**
 * Whether `from` and `to`, two paths in the app's address, are one page for what a Save button says
 * of a change: the same path; or a place's page and the form that reviews it, either way round. The
 * form is the place's child route and opens over it, so opening or closing it is not leaving the place.
 */
function oneVisit(from: string, to: string): boolean {
  return from === to || isFormOver(from, to) || isFormOver(to, from);
}

/**
 * Ends what the Save buttons say of a change once the person goes to another page: that one was not
 * made, or that the first place was just saved, is for the visit it was said in. For the shell, which
 * is there on every page and inside the router: the provider is outside it, and cannot ask where the
 * person is. Before the new page is drawn, so that no button on it is drawn with a line from the page
 * before. Nothing where there is no `SavedProvider` above.
 */
export function useClearSavedLinesOnLeave(): void {
  const store = useContext(SavedContext);
  const { pathname } = useLocation();
  const shown = useRef(pathname);
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = pathname;
    if (!oneVisit(from, pathname)) store?.leftPage();
  }, [store, pathname]);
}
