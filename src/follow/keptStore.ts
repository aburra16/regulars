import type { NostrEvent } from "@nostrify/nostrify";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type { Account } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { type FollowDeps, type FollowOutcome, putBackList } from "./change.ts";
import type { FollowOf } from "./FollowProvider.tsx";
import { type Kept, keptCopies } from "./kept.ts";

/*
 * The copies kept of the follow list of the person signed in (./kept.ts), held for the session for
 * the page that lists them, and the putting back of one: `OwnCopies`, and the hook that page uses
 * (`usePutBack`). Every change to a person's list keeps the list it is built on in this browser
 * before the changed one is signed; here those copies are read from the device's storage, and one
 * is put back when the person presses Put it back.
 *
 * `putBackList` (./change.ts) replaces a person's whole follow list, and is called from that press
 * and from nowhere else: once in src, by `OwnCopies.putBack`, which only what `usePutBack` hands
 * out calls (tests/followGuard.test.ts holds the code to it). Nothing here signs or sends, and
 * nothing here is logged: a list and who it names are the person's.
 *
 * It serves the session that the store of the person's own list holds (`OwnFollows`,
 * ./FollowProvider.tsx), which makes it, and has no session of its own: who is signed in, and on
 * what signal their work is done, are that store's to say (`CopiesHost`). Whether Follow is open
 * (`config.features.follow`) it looks at itself, whoever made it and whatever its host serves
 * (`OwnCopies`). While Follow is not open, or nobody is signed in, there is no session to serve: no
 * copies, the device's storage is not read, and nothing can be put back. The storage is read only
 * while a page lists the copies, and never for a page that shows a Follow button and no more.
 */

/**
 * How a putting back of a copy ended: `done`, the list is as the copy has it; `unchanged`, it was so
 * already; or as a change that did not simply succeed ends (`FollowOf.trouble`).
 */
export type PutBackEnd = "done" | "unchanged" | NonNullable<FollowOf["trouble"]>;

/** What `usePutBack` gives the page that lists a person's kept copies. */
export interface PutBackOf {
  /**
   * The copies of the person's follow list kept in this browser (./kept.ts), newest first: each the
   * list as it was before a change they made here. None until they have been read, when nobody is
   * signed in, and while Follow is not open. The same array until they are read again.
   */
  copies: readonly Kept[];
  /** The copy that is being put back, from the press until it has ended; null when none is. */
  saving: Kept | null;
  /**
   * How the last putting back ended, and of which copy; null once another has begun, and once the
   * person has left the page. The same object for as long as it is that one.
   */
  ended: { readonly copy: Kept; readonly how: PutBackEnd } | null;
  /**
   * Puts `copy` back, in place of the person's list as it is now: for a press of Put it back, and for
   * nothing else. Nothing while one is being put back, or when `copy` is none of `copies`.
   */
  putBack(copy: Kept): void;
}

/** The person signed in, as the store of their own list holds them: whom the copies are of, and what a putting back is made with. */
export interface OwnSession {
  /** The person, with the signer their writes are signed with. */
  account: Account;
  /** Aborts when their session ends, and at no other time. It is the session's own, and no other session's: by it one session is told from the next. */
  signal: AbortSignal;
  /** What a write to their list is made with: the app's relays, its clock, and the keeping of the list the write is built on. */
  writing(): FollowDeps;
}

/** What the copies' store is given by the store of the session's own list, which makes it. */
export interface CopiesHost {
  /** The session, for whatever reads the copies or puts one back; none while nobody is signed in. The app's own gives none while Follow is not open either, and the copies' store does not rely on that. */
  live(): OwnSession | null;
  /**
   * A copy was put back and saved, in the session whose signal is `signal`: `list`, the list that
   * was saved, is the person's list from here on, for every Follow button. Nothing when that
   * session is over.
   */
  wasPutBack(signal: AbortSignal, list: NostrEvent): void;
}

/** A putting back of a copy: the one under way, or the last one, with how it ended. */
interface PuttingBack {
  copy: Kept;
  saving: boolean;
  ended: PutBackOf["ended"];
}

/** What the page that lists a person's copies is told beside the press: `PutBackOf` without it. */
type CopiesTold = Pick<PutBackOf, "copies" | "saving" | "ended">;

/** No copies: frozen, and the same array each time. */
const NO_COPIES: readonly Kept[] = Object.freeze([]);

/** What that page is told while nobody is signed in, or the copies are someone else's. */
const NO_COPIES_TOLD: CopiesTold = Object.freeze({ copies: NO_COPIES, saving: null, ended: null });

/** What is held of the copies for one session, from the first time a page lists them or a write may have kept one, until the session ends. */
interface Held {
  /** The session's own signal: whose copies these are (`OwnSession.signal`). */
  signal: AbortSignal;
  /** Their kept copies, newest first: undefined until they are read for a page that lists them, and once a write has kept one more while none does. */
  copies: readonly Kept[] | undefined;
  /** What that page is told of them: the same object until any of it changes. */
  told: CopiesTold;
  /** How many reads of the copies have begun: what a read finds is held only if none began after it. */
  reads: number;
  /** Whether the last read of the copies begun is still under way. */
  reading: boolean;
  /** The copy being put back, or the last one with how it ended; null when there is neither to tell of. */
  putBack: PuttingBack | null;
}

/**
 * The copies kept of the list of the session's person, for the page that lists them, and the
 * putting back of one. It reads them from the device's storage when a component first listens while
 * someone is signed in, and again once a write to the list has ended, which may have kept one more.
 *
 * It does neither while there is no session to serve: nobody is signed in (`CopiesHost.live`), or
 * Follow is not open (`config.features.follow`), which it looks at itself. Whatever here tells a
 * page anything, reads the storage or puts a copy back takes the session from one place (`#live`),
 * which has none then: so with Follow off nothing is told, read or put back, whoever made the store
 * and whatever session its host would serve.
 */
export class OwnCopies {
  readonly #host: CopiesHost;
  readonly #listeners = new Set<() => void>();
  /** Changes with anything the page that lists the copies is told. */
  #version = 0;
  /** What is held for the session; null until something is, and once that session is over. */
  #held: Held | null = null;

  constructor(host: CopiesHost) {
    this.#host = host;
  }

  /**
   * The session, for whatever tells, reads or puts back; none while Follow is not open, whoever is
   * signed in and whatever the host says. The one place that asks the host: nothing below reads the
   * device's storage, tells a page of a copy or reaches `putBackList` but through it.
   */
  #live(): OwnSession | null {
    return config.features.follow ? this.#host.live() : null;
  }

  /**
   * Calls `listener` after each change, and returns what stops it. A component that listens lists
   * the person's copies, so this reads them from the device's storage when they are not held; it
   * asks no relay anything, and is no reason to read the list itself.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#readIfShown();
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A number that changes with anything that page is told, for `useSyncExternalStore`. */
  readonly version = (): number => this.#version;

  /**
   * What the page that lists the kept copies of the person `pubkey` is told: their copies, the one
   * being put back, and how the last putting back ended. Nothing of anyone's unless `pubkey` is the
   * session's person: when someone else signs in, the session of the person before is still held for
   * the drawing the account changes in, and their copies are not the next person's to see.
   */
  of(pubkey: string): CopiesTold {
    const session = this.#live();
    if (session === null || session.account.pubkey !== pubkey) return NO_COPIES_TOLD;
    return this.#held?.signal === session.signal ? this.#held.told : NO_COPIES_TOLD;
  }

  /**
   * Puts `copy` back as the follow list of the person `pubkey`, in place of their list as it is now:
   * for a press of Put it back, and for nothing else. `putBackList` (./change.ts) makes the write,
   * start to end, by the steps of any change, and keeps the list it replaces first. Nothing unless
   * `pubkey` is the session's person and `copy` is one of the copies held for them (the very
   * object `of` gave, not one like it), nor while one is being put back.
   */
  putBack(pubkey: string, copy: Kept): void {
    const session = this.#live();
    if (session === null || session.account.pubkey !== pubkey) return;
    const held = this.#for(session);
    if (held.putBack?.saving === true) return;
    // Only a copy the session holds, the very one: read from the device's storage, and checked
    // there to be the person's own list. Nothing a caller made up is put back, however like one.
    if (held.copies?.includes(copy) !== true) return;
    const putting: PuttingBack = { copy, saving: true, ended: null };
    held.putBack = putting;
    this.#tell(held);
    this.#changed();
    // On the session's signal, as a change is: it goes on though the person leaves the page.
    putBackList(session.account, copy.list, session.writing(), session.signal).then(
      (outcome) => this.#over(held, putting, outcome),
      () => this.#over(held, putting, null),
    );
  }

  /**
   * The session has begun, ended or changed hands: for the store of the person's own list to say,
   * once it has let go of the one before. What was held for a session that is over is let go of,
   * and the copies of the person signed in now are read, when a page lists them.
   */
  sessionChanged(): void {
    const session = this.#live();
    if (this.#held !== null && this.#held.signal !== session?.signal) {
      this.#held = null;
      this.#changed();
    }
    this.#readIfShown();
  }

  /**
   * The person signed in has gone to another page: called for each page they go to, the page that
   * lists the copies among them. How a putting back ended was for the page it was said on, and is
   * let go of. One under way is kept, and how it ends is told from then until they next go to
   * another page: so it is said if they are on the page that lists the copies as it ends, and not
   * if they come to that page after, as coming to it is going to another page too.
   */
  leftPage(): void {
    const held = this.#heldNow();
    if (held === null || held.putBack === null || held.putBack.saving) return;
    held.putBack = null;
    this.#tell(held);
    this.#changed();
  }

  /**
   * A write to the list of the session's person has ended, and may have kept one more copy on its
   * way. They are read again when a page lists them, and otherwise let go of, to be read when one
   * next does.
   */
  written(): void {
    this.#mayHoldOneMore();
    this.#changed();
  }

  /** What is held for the session as it is now; null when there is no session, or nothing is held for it. */
  #heldNow(): Held | null {
    const session = this.#live();
    return session !== null && this.#held?.signal === session.signal ? this.#held : null;
  }

  /** What is held for `session`, made anew when what is held is another session's, or nothing is. */
  #for(session: OwnSession): Held {
    if (this.#held?.signal !== session.signal) {
      this.#held = { signal: session.signal, copies: undefined, told: NO_COPIES_TOLD, reads: 0, reading: false, putBack: null };
    }
    return this.#held;
  }

  /**
   * A putting back has ended: `outcome` is how, or null when it failed in a way `putBackList` has no
   * name for. Nothing of it is kept when its session is over.
   */
  #over(held: Held, putting: PuttingBack, outcome: FollowOutcome | null): void {
    if (this.#held !== held || held.signal.aborted) return;
    putting.saving = false;
    let how: PutBackEnd;
    if (outcome === null) how = "not-saved";
    else if (outcome.kind === "saved") how = outcome.confirmed ? "done" : "unconfirmed";
    // A copy put back is never asked about, as its page asks first (./change.ts). Were it to end
    // so, nothing was written: it is told as a list that was not loaded, and never as put back.
    else if (outcome.kind === "ask") how = "not-loaded";
    else how = outcome.kind;
    // The session's to tell of from here, until another copy is put back or the person leaves the page.
    putting.ended = Object.freeze({ copy: putting.copy, how });
    // What the buttons show comes from the list that was put back. Not from a list found to be so
    // already: the read that found it need not be one to show a list from.
    if (outcome?.kind === "saved") this.#host.wasPutBack(held.signal, outcome.list);
    this.#mayHoldOneMore();
    this.#tell(held);
    this.#changed();
  }

  /**
   * Reads the copies when a page lists them, someone is signed in, and they are not held. Nothing
   * while Follow is not open, and nothing for a page that does not list them: the device's storage
   * is read for that page alone.
   */
  #readIfShown(): void {
    const session = this.#live();
    if (session === null || this.#listeners.size === 0) return;
    const held = this.#for(session);
    if (held.copies !== undefined || held.reading) return;
    void this.#read(session, held);
  }

  /**
   * Reads the copies of the session's person from the device's storage (`keptCopies`, which gives
   * only those that are their own valid list, and never throws), and holds them, unless a later read
   * has begun or the session is over. The copies held before stay until then.
   */
  async #read(session: OwnSession, held: Held): Promise<void> {
    const read = ++held.reads;
    held.reading = true;
    const copies = await keptCopies(session.account.pubkey);
    if (this.#held !== held || held.reads !== read) return;
    held.reading = false;
    held.copies = Object.freeze(copies);
    this.#tell(held);
    this.#changed();
  }

  /**
   * The copies may be one more than is held (`written`). Read again when a page lists them; let go
   * of otherwise, and while Follow is not open: the device's storage is not read then. The caller
   * tells the listeners.
   */
  #mayHoldOneMore(): void {
    const session = this.#live();
    if (session !== null && this.#listeners.size > 0) {
      void this.#read(session, this.#for(session));
      return;
    }
    const held = this.#held;
    if (held === null) return;
    // What a read still under way finds is let go of too: it may have missed the copy just kept.
    held.reads += 1;
    held.reading = false;
    held.copies = undefined;
    this.#tell(held);
  }

  /** Makes anew what the page that lists the copies is told, from what is held. */
  #tell(held: Held): void {
    const putting = held.putBack;
    held.told = Object.freeze({
      copies: held.copies ?? NO_COPIES,
      saving: putting?.saving === true ? putting.copy : null,
      ended: putting?.ended ?? null,
    });
  }

  /** Notes a change to what that page is told, and tells the listeners. */
  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

/** The copies' store of the session, which `FollowProvider` gives to the pages below it (./FollowProvider.tsx). */
export const CopiesContext = createContext<OwnCopies | null>(null);

/** For a tree with no `FollowProvider`: nothing to listen to. */
const listenToNothing = () => () => {};
const noVersion = () => 0;

/**
 * The copies of the follow list of the person `pubkey` that were kept in this browser, one before
 * each change they made here (./kept.ts), with the putting back of one: for the page that lists them
 * to the person signed in. They are read from the device's storage when a component first uses this
 * while that person is signed in, and again after each change; it asks no relay anything, and the
 * list itself is not read for it.
 *
 * `putBack` replaces the person's whole list with a copy (`putBackList`, ./change.ts), and is for a
 * press of Put it back alone: call it from nothing else (tests/followGuard.test.ts holds the code to
 * that). How it went is told by `saving` and `ended`; a copy put back is the list every Follow button
 * then shows from.
 *
 * When `pubkey` is not the person signed in (nobody is, or someone else signed in a moment ago),
 * while Follow is not open (`config.features.follow`), or with no `FollowProvider` above: no copies,
 * nothing read, and `putBack` does nothing.
 */
export function usePutBack(pubkey: string): PutBackOf {
  const store = useContext(CopiesContext);
  const version = useSyncExternalStore(store?.subscribe ?? listenToNothing, store?.version ?? noVersion);
  const putBack = useCallback((copy: Kept) => store?.putBack(pubkey, copy), [store, pubkey]);

  return useMemo(() => {
    void version; // What the store tells changes with it.
    return { ...(store?.of(pubkey) ?? NO_COPIES_TOLD), putBack };
  }, [store, pubkey, version, putBack]);
}
