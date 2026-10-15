import type { NostrEvent } from "@nostrify/nostrify";
import { createContext, type JSX, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { isNewer } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { isFormOver } from "../review/paths.ts";
import { type Relays, useRelays } from "../score/ScoresProvider.tsx";
import { belowFollowFloor, changeFollow, type FollowDeps, type FollowOutcome, forgetFollowFloor, raiseFollowFloor } from "./change.ts";
import { keepCopy } from "./kept.ts";
import { CopiesContext, OwnCopies } from "./keptStore.ts";
import { followed, type Removed } from "./list.ts";
import { copyToAsk, enoughAnswered, readOwnList } from "./read.ts";

/*
 * The follow list of the person signed in, held for the session so that a button can say Follow or
 * Following: `FollowProvider`, and the hooks the buttons and the person page use (`useFollow`,
 * `useOwnFollowed`). The list is read once a page shows it, from the person's own relays and the
 * follow-list relays, and kept in memory only. It is for what the buttons show and no more: a change
 * is never built on it. A tap goes to `changeFollow` (./change.ts), which reads the list afresh
 * itself, and what the buttons show after comes from the list that change saved or found. Undo is
 * such a tap: for its ten seconds the session keeps what the unfollow took out, and hands it to
 * `changeFollow` to put back as it was (ruling R20). An Undo that did not save leaves both as they
 * were, to be tapped again while those ten seconds last (ruling R22), and a tap of Follow in those
 * ten seconds is that Undo (ruling R28).
 *
 * Nothing here signs or sends (tests/followGuard.test.ts holds this module to that): it reads, and
 * it calls `changeFollow`, on a tap of Follow, Unfollow, Undo or Try again (which makes again the
 * one of those changes that was not made), and on a press of Use this copy (which makes the one of
 * those changes the person was asked about, on the copy they were shown), and at no other time.
 * Nothing here is logged: a list, its entries and the relays a person keeps it on are theirs.
 *
 * Every such change is given the keeping of the list it is built on (`keepCopy`, ./kept.ts): a copy
 * in this browser, kept before the changed list is signed. Those copies, and the putting back of
 * one, are another store's (`OwnCopies`, ./keptStore.ts), which this one makes and serves: it says
 * who is signed in and whether Follow is open, tells it when the session changes, when a write has
 * ended and when the person leaves a page, and takes from it the list a copy put back has left.
 *
 * What a change left to say (that it went wrong, or that a follow was just made) is held for the
 * person it was about, not for a button: every button for them on the page says the same, one that
 * is drawn anew or appears later says it too, and it is let go of when the person signed in goes to
 * another page, or taps again (ruling R19). A place's page and the form that reviews it are one page
 * for this (`sameVisit`, ruling R21). The provider is outside the router, so the shell tells it of
 * each new page (`useClearFollowLinesOnLeave`).
 *
 * How a change went wrong is kept with what that change meant to do, and Try again makes that change
 * again (`retry`): never the one a button's state would suggest, as the list the state comes from is
 * replaced by any change the person makes, to anyone. And it is let go of once the list held no
 * longer agrees with it: a follow that "did not save" of someone the list now names was made after
 * all (ruling R27).
 *
 * One read that is not one to trust still gives the buttons a list to draw from: no relay the
 * person writes to answered, and several of the app's relays hold the same list (`copyToAsk`,
 * ./read.ts). That list may not be their newest, so it is held as one they have not agreed to
 * (`Session.unagreed`): the buttons say Follow and Following from it, and nothing is ever written
 * on the strength of it. It is a list this tab has seen, as every list a read finds is, whatever
 * the read's standing: no change is built on an older one (`raiseFollowFloor`), which only ever
 * stops a change. A press goes to `changeFollow` as any does, which reads afresh and, in that same
 * case, makes no change and says the person may be asked (`ask`). The session then holds what was
 * asked for, for the person it was about (`Asking`), and the button says when the copy was last
 * changed, with two answers. Use this copy asks `changeFollow` for that very change again, with
 * the id of the list they were shown (`useCopy`); Not now lets the asking go; and a tap of that
 * person's button, in place of an answer, asks for that same change again and no other. One person
 * is asked about at a time.
 * After a change made by their say has saved and been read back as the newest, the list it saved
 * is the one they are taken to have agreed to build on for the rest of the session
 * (`Session.allowed`), so the next change asks nothing while that very list is still the newest;
 * any other newest, and they are asked again.
 *
 * No button draws from a list older than one this tab has seen (the floor, ./change.ts), as every
 * press would be held to that newer list and could not load. A read whose newest list is older,
 * or that found none where a list has been seen, holds nothing, whether or not it is one to trust,
 * as a read that is not one to trust with nothing to ask about holds nothing; and a copy held that
 * is older is let go of. The list is then read again as one that is not known is, and a read that
 * finds a list at the floor or above draws the buttons again.
 *
 * While Follow is not open (`config.features.follow`, ruling R39) none of this happens: nothing is
 * known of anyone, no relay is asked anything, and a tap is no change. The store holds itself to
 * that (`OwnFollows`), whatever a component that uses it does.
 */

/**
 * What a button for a person shows:
 * - `unknown`: nobody is signed in, or the list of the person who is has not been read, or could not
 *   be, or was found only older than one this tab has seen: no button says Follow or Following, as
 *   either might be wrong;
 * - `not-following`, `following`: as the list has it. The list may be one that could not be trusted,
 *   which the person has not agreed to yet: a press then asks them first (`FollowOf.asking`);
 * - `saving`: a change to this person's place in the list is under way.
 */
export type FollowState = "unknown" | "not-following" | "following" | "saving";

/** What `useFollow` gives a button for one person. */
export interface FollowOf {
  state: FollowState;
  /**
   * The last change's outcome when it did not simply succeed, for the line under the button; cleared
   * on the next tap, gone once the person has left the page, and gone once the list held no longer
   * agrees with it (ruling R27). The same on every button for them.
   */
  trouble: "not-loaded" | "not-kept" | "not-approved" | "not-saved" | "unconfirmed" | null;
  /**
   * True for 10 s after an unfollow by this person in this tab (`UNDO_MS`), unless Undo has put them
   * back or another tap has followed them since; not while a tap of Undo is being saved. An Undo that
   * did not save leaves it true for what is left of those ten seconds (ruling R22).
   */
  canUndo: boolean;
  /**
   * True after a tap of Follow by this person in this tab that left them followed, until they leave
   * the page or tap again: shows the after-follow line. The same on every button for them. Not after
   * Undo, which puts back what was there before and changes nothing for their circle (ruling R23).
   */
  justFollowed: boolean;
  /**
   * Set while the person signed in is asked about a change to this person: their press was not
   * made, as no relay they write to answered, and the list the change would be built on is a copy
   * found on the app's relays, which may not be their newest. `changed` is when that copy was last
   * changed, in seconds: what they are told, as only they know whether they have followed anyone
   * since. Null when they are not asked. One person is asked about at a time, and it goes:
   * - on the next tap for them: their answer (`useThisCopy`), or a tap of their button, which asks
   *   for that same change again; and on `notNow`;
   * - when a change to anyone comes back asking, which takes its place; and when a change to anyone
   *   is saved, or finds the list so already;
   * - when the page's read is one to trust (a relay of the person's own answered, say) and finds
   *   the copy they were shown; and once this tab has seen a newer list than that copy, which a
   *   read of the page's or a change, for anyone, found: at the end of that change, or at the next
   *   read. Not when a read finds only an older one, or none: it has missed the copy;
   * - when a copy put back is saved: the list is that one now;
   * - once the list held has this person as the change would leave them;
   * - when the person leaves the page, and with the session.
   * The same on every button for them.
   */
  asking: { changed: number } | null;
  /**
   * Follows the person: for a tap of Follow. While Undo is offered for them it is that Undo, which
   * puts them back as they were (ruling R28). Nothing while a change to them is under way, or nobody
   * is signed in. Whether it began a plain follow: one that adds them to the list, which the last
   * update of the person's circle did not count. Not an Undo, which adds nobody, and not a tap that
   * began nothing. The button asks, and does not work it out from what it shows (ruling R24).
   * While the person is asked about a change to this one (`asking`), it is that change asked for
   * again, with no answer: what Undo was to put back, though Undo's ten seconds are over.
   */
  follow(): boolean;
  /**
   * Unfollows the person: for a press of Unfollow, which the button says before it unfollows. Nothing
   * while a change to them is under way, or nobody is signed in. While the person is asked about a
   * change to this one, it is that change asked for again, as for `follow`: an asking is for the
   * change the button offers, so under a button that says Unfollow it is an unfollow's.
   */
  unfollow(): void;
  /**
   * Follows the person again, with what the unfollow took out of the list put back as it was and
   * where it was: for a tap of Undo. Nothing unless `canUndo`.
   */
  undo(): void;
  /**
   * Makes again the change `trouble` is about: for a tap of Try again. A follow that was not made is
   * a follow (as `follow` is, so Undo while that is offered), an unfollow that was not made an
   * unfollow, whatever the button says by now (ruling R27). Nothing when nothing went wrong, or when
   * what went wrong is that a saved change could not be checked (`unconfirmed`). Whether it began a
   * plain follow, as `follow` says.
   */
  retry(): boolean;
  /**
   * Makes the change the person was asked about (`asking`), on the copy they were shown: for a
   * press of Use this copy, and for nothing else (tests/followGuard.test.ts holds the code to
   * that). It is the very change that asked, kept with the asking: a follow, an unfollow, or what
   * Undo puts back, exactly. Nothing unless they are asked about this person. Whether it began a
   * plain follow, as `follow` says.
   */
  useThisCopy(): boolean;
  /** Lets the asking go, and changes nothing: for a press of Not now. Nothing unless the person is asked about this one. */
  notNow(): void;
}

/** How long Undo is offered after an unfollow, in milliseconds. */
export const UNDO_MS = 10_000;

/**
 * How long a list that could not be read is left unread, in milliseconds, from the end of the read
 * that could not tell (rulings R26 and R30). Every review drawn has a button's part, so a view
 * toggled or folded reviews opened would each have it read again, from every relay, for as long as
 * the relays cannot say.
 */
export const FOLLOW_REREAD_MS = 30_000;

/** What a button is told of a person beside the taps: `FollowOf` without them. */
type Told = Pick<FollowOf, "state" | "trouble" | "canUndo" | "justFollowed" | "asking">;

/** What every button is told while nobody is signed in. */
const NOTHING_KNOWN: Told = { state: "unknown", trouble: null, canUndo: false, justFollowed: false, asking: null };

/** What a change does to the list: a follow, an unfollow, or putting back what an unfollow took out (`changeFollow`). */
type Action = Parameters<typeof changeFollow>[2];

/** Whether a change is Undo's: one that puts back what an unfollow took out. */
const isUndo = (action: Action): action is Exclude<Action, string> => typeof action !== "string";

/**
 * What Undo has to go on, for as long as it is offered: `UNDO_MS` from the unfollow, or until Undo
 * has put the person back, or a tap of Follow or Unfollow has changed their place in the list.
 */
interface Undo {
  /** What ends it, `UNDO_MS` after the unfollow. */
  timer: ReturnType<typeof setTimeout>;
  /** What the unfollow took out of the list, each entry as the list wrote it and where it was: what Undo puts back. */
  restore: readonly Removed[];
  /** The id of the list the unfollow saved: only into that very list do the entries go back to their places. */
  left: string;
}

/** How a change to a person's place in the list went wrong, with what the change was. */
interface Trouble {
  /** How it ended. */
  how: NonNullable<FollowOf["trouble"]>;
  /** What it meant to do: to follow them (a tap of Follow, or of Undo), or to unfollow them. What Try again does again. */
  meant: "follow" | "unfollow";
  /**
   * The change itself, as it was asked for, when it was made through an asking: by the person's
   * answer (Use this copy), or by a press in place of one. Try again then makes that very change
   * again, and not what `meant` would make of a tap now: what Undo was to put back, as it was,
   * though Undo's ten seconds ended while they were asked, where a plain follow would add a bare
   * entry. Left out for a change no asking was part of.
   */
  exact?: Action;
}

/** What the session holds of one person a button was tapped for. */
interface Person {
  /** Whether a change to their place in the list is under way: from the tap until it has ended. */
  saving: boolean;
  /**
   * How the last change to them ended when it did not simply succeed; null from the next tap, once
   * the person signed in has left the page, and once the list held no longer agrees with it.
   */
  trouble: Trouble | null;
  /** Whether the last change to them was a follow that ended with them followed; false from the next tap, and once the person signed in has left the page. */
  justFollowed: boolean;
  /** What Undo puts back, while it is offered; undefined when there is nothing to undo, and nothing of the unfollow is kept. */
  undo: Undo | undefined;
}

/**
 * What the person signed in is asked about: a change that was not made, as it could only be built
 * on a copy of their list that may not be their newest. Held from the change's end until it is
 * answered or overtaken (`FollowOf.asking` lists each way it goes): they answer, or tap again for
 * that person; a change to anyone asks in its place, or comes to a list; a read to trust finds the
 * copy; this tab sees a newer list than the copy, by any read or change; a copy put back is saved;
 * the list held has the person so already; they go to another page; or the session ends.
 */
interface Asking {
  /** Whom the change is to, by their key in lower case. */
  who: string;
  /** The change that asked, exactly as it was asked for: what Use this copy makes again. Undo's is what its unfollow took out, kept here though Undo's own time ends meanwhile. */
  action: Action;
  /** The copy `changeFollow` said they may be asked about: its id, which their answer is for, and when it was last changed. */
  copy: { id: string; changed: number };
  /** What a button is told of it: the same object for as long as it is this asking. */
  told: { changed: number };
}

/**
 * Whether the copy `asking` is about is older than a list this tab has seen of `pubkey`'s (the
 * floor, `belowFollowFloor`): a read or a change, for anyone, has found a newer one since. The copy
 * is then known not to be the newest, every change on it would not load, and there is nothing
 * left to ask. False when nothing is asked.
 */
function outOfDate(pubkey: string, asking: Asking | null): boolean {
  return asking !== null && belowFollowFloor(pubkey, { id: asking.copy.id, created_at: asking.copy.changed });
}

/** What is held for the person signed in, from their sign-in until they sign out or someone else signs in. */
interface Session {
  /** The person, with the signer their changes are signed with. */
  account: Account;
  /** Aborts when the session ends, and at no other time: the read of the list and every change are made on its signal. */
  stop: AbortController;
  /** Their follow list: undefined until it is read, null once it is known that they have none. */
  list: NostrEvent | null | undefined;
  /**
   * Whether `list` is a copy the person has not agreed to: found by the page's own read when that
   * was not one to trust, on enough of the app's relays that they may be asked about it
   * (`copyToAsk`, ./read.ts). It is held for the buttons to draw from and for nothing else: a
   * press asks before anything is built on it, and it is read again as a list that is not known
   * is. A newer list that a later read or a change comes to takes its place, as does that very
   * list once a read to trust finds it; an older one never does. A later read that is not one to
   * trust and finds a newer list lets go of it: by another copy to ask about, or by none, and then
   * no button is drawn. So does a later read with nothing to ask about once this tab has seen a
   * newer list than it, wherever (`belowFollowFloor`). It is a list this tab has seen
   * (`raiseFollowFloor`), as every list a read finds is: nothing is built on an older one. A list
   * that a change made by the person's say found to be so already, with nothing saved, is such a
   * copy too: it is that same copy. False for a list a read to trust found, for one a change saved,
   * and for one a change built on a read to trust found.
   */
  unagreed: boolean;
  /** Who `list` names: null until it is read. The same array until the list changes. */
  followed: readonly string[] | null;
  /** The same keys with whose list they are (`useOwnFollowed`): null until it is read, and while it is a copy the person has not agreed to (`unagreed`). The same object for as long as `followed` is the same array. */
  owned: OwnFollowed | null;
  /** The same keys, for a button's question of one person: made once when the list is held, so that an answer takes no longer for a long list. */
  follows: ReadonlySet<string>;
  /** Whether the list is being read. */
  reading: boolean;
  /**
   * When the last read ended that left the list unknown, or held only as a copy the person has not
   * agreed to (`unagreed`); undefined until one has. No read is begun for `FOLLOW_REREAD_MS` from
   * then. By the clock that only goes forward (`performance.now()`), not the device's date, which
   * can be set: put back, it would keep the list unread for as long as it was put back by.
   */
  unread: number | undefined;
  /** The people a button was tapped for, by key. */
  people: Map<string, Person>;
  /** What the person is asked about; null when nothing. One at a time: the next change that asks takes its place. */
  asking: Asking | null;
  /**
   * The id of the list the person is taken to have agreed to build on, with no relay of their own
   * answering: the list the last change made by their say saved and read back as the newest, in
   * this session. So it is only ever a list this tab itself saved after they said to use a copy
   * they were shown, and a change goes on by it only while that very list is the newest
   * (`changeFollow`'s `allowed`). Undefined until such a change has saved and been confirmed: one
   * that could not be checked begins nothing, and leaves what was there. It lasts the session, as what this tab has seen of the list
   * does: not let go of when a page is left, and gone with the session.
   */
  allowed: string | undefined;
}

/** Who a person follows, with who that person is: a list is one person's, and is never to be taken for the next person's. */
export interface OwnFollowed {
  /** The public key of the person whose list it is, in lower case. */
  owner: string;
  /** Who they follow: the valid keys their list names, in its order, each once. The same array until the list changes. */
  followed: readonly string[];
}

/**
 * Whether no list from the relays in `answered` is enough to say the person follows nobody: only
 * when as many of the app's follow-list relays answered as a first list needs (`enoughAnswered`,
 * ./read.ts: more than half of them and no fewer than three). One relay's nothing proves nothing, as
 * some keep no lists, and a button that said Follow of someone the person follows would be wrong.
 * The person's own relays do not make up the number.
 */
const followsNobody = enoughAnswered;

/**
 * The session's own follow list, which `FollowProvider` holds for the hooks below. It reads the list
 * when a component first listens while someone is signed in, and makes each change the buttons ask
 * for, one at a time for each person (`changeFollow` takes them in turn).
 *
 * While Follow is not open (`config.features.follow`, ruling R39) it does neither, whoever asks.
 * Whatever here tells a button anything, reads the list or starts a change takes the session from
 * one place (`#live`), which has none then: so every button is told that nothing is known, as when
 * nobody is signed in, no relay is asked anything, and a tap never reaches `changeFollow`.
 */
class OwnFollows {
  readonly #relays: Relays;
  readonly #listeners = new Set<() => void>();
  /** Changes with anything a button or a page is told. */
  #version = 0;
  /** What is held for the person signed in; null while nobody is. */
  #session: Session | null = null;

  /**
   * The session, for whatever tells, reads or changes; none while Follow is not open (ruling R39),
   * whoever is signed in. The one place that looks: nothing below reaches a relay, or tells a
   * button of a list, but through it.
   */
  #live(): Session | null {
    return config.features.follow ? this.#session : null;
  }

  /**
   * The copies kept of the list of the session's person, and the putting back of one
   * (./keptStore.ts). It serves this store's session, and none of its own: through `#live`, so that
   * it reads and writes nothing while Follow is not open, which it looks at itself besides.
   */
  readonly copies: OwnCopies;

  constructor(relays: Relays) {
    this.#relays = relays;
    this.copies = new OwnCopies({
      live: () => {
        const session = this.#live();
        return session === null ? null : { account: session.account, signal: session.stop.signal, writing: () => this.#writingFor(session) };
      },
      wasPutBack: (signal, list) => this.#wasPutBack(signal, list),
    });
  }

  /**
   * Calls `listener` after each change, and returns what stops it. A component that listens shows
   * the list, so this reads it when it is not known and is not being read: the first time for a
   * session, and again after a read that could not tell, when a button next appears once
   * `FOLLOW_REREAD_MS` have passed.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#readIfShown();
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A number that changes with anything a button is told, for `useSyncExternalStore`. */
  readonly version = (): number => this.#version;

  /**
   * Who the person signed in follows, with whose list it is (`OwnFollowed`): the person the session
   * is for. Null until their list is read, and when nobody is signed in; and while the list held is
   * a copy they have not agreed to, which the buttons draw from and nothing else is told of. The
   * same object until the list changes.
   */
  readonly owned = (): OwnFollowed | null => this.#live()?.owned ?? null;

  /**
   * Who is signed in: `account`, or nobody. When it is someone else than before, or nobody, what was
   * held for the person before is let go of: their list, what their buttons were told, and what this
   * tab saw of their list (`forgetFollowFloor`); the read of it and every change of theirs still
   * under way are stopped, and nothing of them is kept. The same person signed in anew keeps it.
   */
  setAccount(account: Account | undefined): void {
    const session = this.#session;
    if (session !== null && session.account.pubkey === account?.pubkey) {
      session.account = account;
    } else {
      this.#end();
      if (account !== undefined) {
        this.#session = {
          account,
          stop: new AbortController(),
          list: undefined,
          unagreed: false,
          followed: null,
          owned: null,
          follows: new Set(),
          reading: false,
          unread: undefined,
          people: new Map(),
          asking: null,
          allowed: undefined,
        };
      }
    }
    this.#readIfShown();
    this.copies.sessionChanged();
  }

  /**
   * What a button for `who`, a lower-case key, is told: the same whichever button asks, and whenever
   * it began to. The lines that say how a change ended, and that a follow was just made, are the
   * person's for the page's visit (`leftPage`): a button drawn anew on the page, or one that appears
   * later, says them as the others do.
   */
  of(who: string): Told {
    const session = this.#live();
    if (session === null) return NOTHING_KNOWN;
    const person = session.people.get(who);
    let state: FollowState;
    if (person?.saving === true) state = "saving";
    else if (session.list === undefined) state = "unknown";
    else state = session.follows.has(who) ? "following" : "not-following";
    return {
      state,
      trouble: person?.trouble?.how ?? null,
      // Not while Undo itself is being saved: the button says Saving, and offers nothing.
      canUndo: person?.undo !== undefined && !person.saving,
      // Only beside a button that says Following.
      justFollowed: state === "following" && person?.justFollowed === true,
      // Only for the one person the asking is about: a tap for them ends it as it begins a change.
      asking: session.asking?.who === who ? session.asking.told : null,
    };
  }

  /**
   * The person signed in has gone to another page. What a change left to say was for the page it
   * was said on (ruling R19): how one went wrong, that a follow was just made, and what the person
   * was asked about, are let go of, for everyone. Not Undo, which has its ten seconds wherever the
   * person goes; and not a change under way, whose end is told on the page they are on by then.
   */
  leftPage(): void {
    // How a putting back of a copy ended is for the page it was said on too.
    this.copies.leftPage();
    const session = this.#live();
    if (session === null) return;
    // What the person was asked about was asked on that page: it goes as the other lines do. What
    // they agreed to for the session (`allowed`) stays.
    let said = session.asking !== null;
    session.asking = null;
    for (const person of session.people.values()) {
      if (person.trouble === null && !person.justFollowed) continue;
      person.trouble = null;
      person.justFollowed = false;
      said = true;
    }
    if (said) this.#changed();
  }

  /**
   * Follows or unfollows `who`, a lower-case key, for the person signed in: for a tap of Follow or
   * Unfollow. Nothing when nobody is signed in, or while a change to `who` is under way. The change
   * is `changeFollow`'s, start to end, and may be asked for before the list here has been read: it
   * reads the list itself. A follow while Undo is offered for `who` is that Undo (`undo`). Whether a
   * plain follow was begun: a follow that is no Undo, and that was started.
   *
   * While the person is asked about a change to `who`, a tap for them is that change asked for
   * again, whatever `action` says: the one that asked, kept with the asking, and never another. It
   * goes with no answer, so it asks again, with the copy as it is found then. So a press of the
   * button, made in place of an answer once Undo has asked and its ten seconds are over, is still
   * that Undo, with what it was to put back as it was, and no plain follow in its place.
   */
  change(who: string, action: "follow" | "unfollow"): boolean {
    const asking = this.#live()?.asking;
    if (asking !== undefined && asking !== null && asking.who === who) return this.#start(who, asking.action, "asking") && asking.action === "follow";
    // A follow of someone Undo is offered for is that Undo, whichever control asked for it: what the
    // unfollow took out goes back as it was, so nothing of it is lost in its ten seconds (ruling R28).
    const offered = action === "follow" ? this.#live()?.people.get(who)?.undo : undefined;
    const started = this.#start(who, offered === undefined ? action : { restore: offered.restore, left: offered.left });
    return started && action === "follow" && offered === undefined;
  }

  /**
   * Puts `who` back in the list as they were before the unfollow, while Undo is offered for them: for
   * a tap of Undo. What the unfollow took out, and the list it left, go to `changeFollow`, which puts
   * them back by the same steps as any change (ruling R20). They are kept until it has ended, and
   * after it if it did not save, for the next tap of Undo (ruling R22).
   */
  undo(who: string): void {
    if (this.#live()?.people.get(who)?.undo !== undefined) this.change(who, "follow");
  }

  /**
   * Makes again the change that went wrong for `who`: for a tap of Try again. It is the change that
   * was asked for, kept with how it ended, and not what the list held would make of a tap now
   * (ruling R27). Nothing when nothing went wrong for them, or the change was saved and only its
   * check failed. Whether a plain follow was begun, as `change` says.
   *
   * A change that was made through an asking is made again as it was (`Trouble.exact`), with no
   * answer: so it reads afresh, and where the person is still to be asked, asks them again. What
   * Undo was to put back is put back by it, though Undo's ten seconds are long over.
   */
  retry(who: string): boolean {
    const trouble = this.#live()?.people.get(who)?.trouble;
    if (trouble === undefined || trouble === null || trouble.how === "unconfirmed") return false;
    if (trouble.exact !== undefined) return this.#start(who, trouble.exact, "asking") && trouble.exact === "follow";
    return this.change(who, trouble.meant);
  }

  /**
   * Makes the change the person was asked about for `who`, on the copy they were shown: for a press
   * of Use this copy, their answer, and for nothing else. It is the change that asked, kept with
   * the asking, and never what the list held or the button would make of a tap now: a follow, an
   * unfollow, or what Undo puts back, as it was. `changeFollow` is asked for it again with the id
   * of that copy, and makes it only if its own fresh read finds that very list, kept first; another
   * list the newest, and it asks again. Nothing unless the person is asked about `who`, nor while a
   * change to them is under way. Whether a plain follow was begun, as `change` says.
   */
  useCopy(who: string): boolean {
    const asking = this.#live()?.asking;
    if (asking === undefined || asking === null || asking.who !== who) return false;
    return this.#start(who, asking.action, { answer: asking.copy.id }) && asking.action === "follow";
  }

  /** Lets go of what the person was asked about for `who`, and changes nothing: for a press of Not now. Nothing unless they are asked about `who`. */
  notNow(who: string): void {
    const session = this.#live();
    if (session === null || session.asking?.who !== who) return;
    session.asking = null;
    this.#changed();
  }

  /**
   * Starts a change to `who`'s place in the list, on a tap, unless one is under way, nobody is signed
   * in, or Follow is not open. Whether it started one.
   *
   * `through` says that the change is made through an asking: `{ answer }`, with the id of the copy
   * the person has just said to use, for a press of Use this copy (`useCopy`) and no other tap; or
   * `"asking"`, with no answer, for a press made in place of an answer and for Try again after
   * either. Such a change is remembered as it is if it goes wrong, for Try again (`Trouble.exact`).
   * Without an answer, the change is given what they are taken to have agreed to for the session
   * (`Session.allowed`: the list the last change made by their say saved), or nothing. Either is
   * the id of one list, and `changeFollow` goes by it only when its own fresh read finds that very
   * list the newest, with no relay of the person's own answering.
   */
  #start(who: string, action: Action, through?: "asking" | { answer: string }): boolean {
    const session = this.#live();
    if (session === null) return false;
    const person: Person = session.people.get(who) ?? { saving: false, trouble: null, justFollowed: false, undo: undefined };
    session.people.set(who, person);
    if (person.saving) return false;
    person.saving = true;
    // The tap ends what the last change left to say, and what the person was asked about for them:
    // it is answered, or asked again. A tap of Follow or Unfollow ends its Undo too, with what that
    // had to put back; a tap of Undo keeps both until it is known to have saved, as one that did
    // not is tapped again (ruling R22).
    person.trouble = null;
    person.justFollowed = false;
    if (session.asking?.who === who) session.asking = null;
    if (!isUndo(action)) this.#endUndo(person);
    this.#changed();

    // The session's signal, and no other: it aborts when the person signs out or someone else signs
    // in, and when the app goes away. Not when the change has ended, nor when its button has gone:
    // slower relays are still being sent the list on it then (`FOLLOW_SETTLE_MS`, ./change.ts).
    const say = typeof through === "object" ? through.answer : session.allowed;
    const asked = through !== undefined;
    changeFollow(session.account, who, action, this.#writingFor(session), session.stop.signal, say).then(
      (outcome) => this.#over(session, who, person, action, asked, outcome),
      () => this.#over(session, who, person, action, asked, null),
    );
    return true;
  }

  /**
   * What a write to the list of the session's person is made with: the app's relays, the device's
   * clock, and the keeping of the list it is built on, in this browser, under that person's key and
   * by that same clock (`keepCopy`, ./kept.ts).
   */
  #writingFor(session: Session): FollowDeps {
    const { readers, writers } = this.#relays;
    const { pubkey } = session.account;
    const now = () => Math.floor(Date.now() / 1000);
    return { readers, writers, now, keep: (list, why, spare) => keepCopy(pubkey, list, why, now(), spare) };
  }

  /**
   * Reads the list when a component shows it, someone is signed in, and it is neither known nor being
   * read. Not within `FOLLOW_REREAD_MS` of a read that left it unknown, or held only as a copy the
   * person has not agreed to: it is a wait and no more, with no timer, so a page that stays open is
   * not read for again, and the first button to appear once the wait is over has the list read. A
   * new session has no wait. A tap is not held up by it: a change reads the list itself. Nothing
   * while Follow is not open.
   */
  #readIfShown(): void {
    const session = this.#live();
    if (session === null || this.#listeners.size === 0 || session.reading) return;
    // Known, by a read to trust or by a change: it is not read again. A copy the person has not
    // agreed to is not that, and is read for again as a list that is not known is.
    if (session.list !== undefined && !session.unagreed) return;
    if (session.unread !== undefined && performance.now() - session.unread < FOLLOW_REREAD_MS) return;
    session.reading = true;
    void this.#read(session);
  }

  /**
   * Reads the list of the session's person from their own relays and the follow-list relays, for the
   * buttons: the read a change makes too (`readOwnList`), with the same times. It only reads. A read
   * that is not one to trust (their relay list could not be read, or no relay it writes to
   * answered: rulings R43 and R44), and one that finds no list and too few relays to say there is
   * none (`followsNobody`), leave the list unknown: no button shows, and one that appears once
   * `FOLLOW_REREAD_MS` have passed has it read again.
   *
   * One read that is not one to trust gives the buttons a list all the same: the one the person may
   * be asked about (`copyToAsk`, ./read.ts, which a change asks too). It is held as a copy they
   * have not agreed to (`Session.unagreed`), for the buttons to draw from and for nothing more: a
   * press that would change it comes back asking, as `changeFollow` reads afresh and decides for
   * itself. Whether no list means that the person follows nobody is never asked of such a read.
   * Any other read that is not one to trust holds nothing. It takes a copy that is held away in
   * one case: when that copy is older than a list this tab has seen (`belowFollowFloor`), as when
   * the newest list this read found is newer than it; the copy is then known not to be the
   * newest, and no button is drawn from it (`#letGo`). And what the person is asked about goes
   * whenever this tab has seen a newer list than the copy they were shown, whatever the read's
   * standing: this read found one, or one was seen before it. The same list on fewer relays, an
   * older list, and a read that found no list or could not learn where it is kept, take nothing
   * away from a copy no older than any seen: such a read has told nothing, or has missed a list
   * this tab has seen.
   *
   * Every list a read finds is one this tab has seen from then on (`raiseFollowFloor`), whatever
   * the read's standing and whether or not it is held: no change is built on an older one. And a
   * read whose newest list is older than one this tab has seen, or that found none where one has
   * been seen, is held to the same as one that is not to trust with nothing to ask about, however
   * it stands: no button draws from what it found, as every press would be held to the newer list
   * and could not load.
   */
  async #read(session: Session): Promise<void> {
    const { pubkey } = session.account;
    const { signal } = session.stop;
    const { readers } = this.#relays;
    try {
      const read = await readOwnList(pubkey, readers, signal);
      if (this.#session !== session) return;
      const { list, answered } = read;
      // A list of theirs, checked as theirs by the reader: this tab has seen it from here on,
      // whether or not the read is one to trust and whether or not a button draws from it, and no
      // change is built on an older one (ruling R18). That only ever stops a change.
      if (list !== null) raiseFollowFloor(pubkey, list);
      const { asking } = session;
      // Whether the copy the person is asked about is older than a list this tab has seen: this
      // read found a newer one, or one was seen before it. That copy is then known not to be the
      // newest.
      const overtaken = outOfDate(pubkey, asking);
      // The newest it found is older than a list this tab has seen, or it found none: it has
      // missed that list, which a change found or saved, or another read. Every press would be held
      // to that list (./change.ts) and could not load, so no button draws from what this one
      // found, however it stands: it is taken as a read that is not one to trust, with nothing to
      // ask about. A later read that finds a list at the floor or above draws them again.
      const missed = belowFollowFloor(pubkey, list);
      if (!read.trusted || missed) {
        // Not their list as far as it can be known. In one case it is shown, not yet agreed to.
        const copy = missed ? null : copyToAsk(read, Math.floor(Date.now() / 1000));
        let told = false;
        if (copy !== null) told = this.#hold(session, copy, true);
        // No list to ask about, and the copy held is older than a list this tab has seen: one
        // this read found, newer than the copy and on too few relays to ask about, or one seen
        // before it. That copy is known not to be the newest, and no button is drawn from it. The
        // same list on fewer relays, an older one, and a read that found none, say nothing
        // against a copy that is no older than any seen, and it stays.
        else if (session.unagreed && session.list !== null && session.list !== undefined && belowFollowFloor(pubkey, session.list)) told = this.#letGo(session);
        // What they are asked about is one copy, shown with its date: a newer list seen, and the
        // asking is let go of with it, whether or not there is another copy to ask about, and
        // whether or not a button draws: nothing is left asked about that no button shows.
        if (overtaken) {
          session.asking = null;
          told = true;
        }
        if (told) this.#changed();
        return;
      }
      let told = (list !== null || followsNobody(answered)) && this.#hold(session, list);
      // A read to trust: where their other apps keep their list was reached (a relay of their own
      // answered), or the app's relays are where it is. There is no more to ask them about a copy
      // found elsewhere: a press is an ordinary change. Not when it found only an older list than
      // that copy, or none: it has then missed a list this tab has seen, and tells nothing.
      if (asking !== null && (overtaken || list?.id === asking.copy.id)) {
        session.asking = null;
        told = true;
      }
      if (told) this.#changed();
    } catch {
      // Stopped (the person signed out, or someone else signed in), or something unexpected went
      // wrong: a relay that fails or is slow is not thrown for. Either way nothing of it is kept: the
      // list stays as it was, unknown when it was, and then no button says Follow or Following.
    } finally {
      session.reading = false;
      // Still not known for sure, however the read ended: it is not read again for a while. (A
      // session that has ended is asked nothing more, so what is noted of it is never looked at.)
      if (session.list === undefined || session.unagreed) session.unread = performance.now();
    }
  }

  /**
   * Holds `list` as the session's person's (null: they have none), unless a newer one is held: a
   * read that ends after a change has saved a newer list does not put the older one back. What was
   * said of anyone that the list no longer agrees with is let go of (`#agree`). Whether what is held
   * changed; the caller tells the listeners.
   *
   * `unagreed` is for a copy the person has not agreed to (`Session.unagreed`): from the page's own
   * read, or from a change made by their say that saved nothing. Whichever kind the list held and
   * the new one are, a newer one takes the older one's place and an older one never does: every
   * list held is one this tab has seen, so a read that finds only an older one has missed it. The
   * very list that is held takes its own place only to be surer: a copy not agreed to, once a read
   * to trust finds it or a change saves or builds on it.
   */
  #hold(session: Session, list: NostrEvent | null, unagreed = false): boolean {
    const held = session.list;
    if (held === null && list === null) return false;
    if (held !== undefined && held !== null) {
      // Older than the list held, or none where one is held: the read that found it has missed a
      // list this tab has seen, and what is held stays, whichever of the two is the surer.
      if (list === null || isNewer(held, list)) return false;
      // The very list that is held: nothing changes, unless it was a copy not agreed to and is
      // now found by a read to trust, or saved or built on by a change.
      if (list.id === held.id && (unagreed || !session.unagreed)) return false;
    }
    session.list = list;
    session.unagreed = unagreed;
    session.followed = Object.freeze(followed(list));
    // Whose list it is, for what reads other people's records from it: not told of a copy the
    // person has not agreed to, which is for the buttons alone.
    session.owned = unagreed ? null : Object.freeze({ owner: session.account.pubkey.toLowerCase(), followed: session.followed });
    session.follows = new Set(session.followed);
    this.#agree(session);
    return true;
  }

  /**
   * Lets go of a copy the person has not agreed to: the list is not known again, no button says
   * Follow or Following, and it is read for again as a list that is not known is. Nothing unless
   * what is held is such a copy. Whether what is held changed; the caller tells the listeners.
   */
  #letGo(session: Session): boolean {
    if (!session.unagreed) return false;
    session.list = undefined;
    session.unagreed = false;
    session.followed = null;
    session.owned = null;
    session.follows = new Set();
    return true;
  }

  /**
   * A change to `who` has ended: `outcome` is how, or null when it failed in a way `changeFollow` has
   * no name for. `asked` is whether it was made through an asking (`#start`). Nothing of it is kept
   * when its session is over (the person signed out, or someone else signed in): it was given up.
   */
  #over(session: Session, who: string, person: Person, action: Action, asked: boolean, outcome: FollowOutcome | null): void {
    if (this.#session !== session) return;
    person.saving = false;
    // What the person was asked about before, for anyone, goes once its copy is older than a list
    // this tab has seen: this change's own read may have found a newer one, and nothing can be made
    // on that copy now. An asking this change makes is about the newest list its read found, which
    // is no older than any seen.
    if (outOfDate(session.account.pubkey, session.asking)) session.asking = null;
    // What the change meant to do, for Try again: Undo is a follow, of the kind that puts back.
    const meant = action === "unfollow" ? "unfollow" : "follow";
    /** How it went wrong, with what Try again makes again: the change itself, when it was made through an asking. */
    const wrong = (how: Trouble["how"]): Trouble => (asked ? { how, meant, exact: action } : { how, meant });
    if (outcome === null) {
      // Not a change given up, as its session goes on. Nothing `changeFollow` does once it has sent a
      // list fails so, so no list was saved. An Undo that ended so is offered still (ruling R22).
      person.trouble = wrong("not-saved");
    } else if (outcome.kind === "ask") {
      // Not made: it could only be built on a copy that may not be the person's newest list, and
      // they are asked. What was asked for is kept as it was, for their answer (`useCopy`); it takes
      // the place of whatever they were asked before, for anyone. Nothing went wrong, and nothing
      // of the list is held from it. An Undo that ended so is offered still.
      session.asking = { who, action, copy: outcome.copy, told: Object.freeze({ changed: outcome.copy.changed }) };
    } else if (outcome.kind === "saved" || outcome.kind === "unchanged") {
      if (outcome.kind === "saved" && !outcome.confirmed) person.trouble = wrong("unconfirmed");
      // Followed by a tap of Follow, by this change or already: the line under the button says what
      // that means for the person's circle. Not when Undo put them back, as nothing has changed for
      // it (ruling R23).
      person.justFollowed = action === "follow";
      // Put back, or found in the list already: there is nothing more to undo.
      if (isUndo(action)) this.#endUndo(person);
      // Only an unfollow that took them out can be undone: what it took out is kept for Undo's ten
      // seconds, and then forgotten, whatever a tap of Undo came to meanwhile.
      if (action === "unfollow" && outcome.kind === "saved" && outcome.removed !== undefined) {
        const timer = setTimeout(() => {
          person.undo = undefined;
          this.#changed();
        }, UNDO_MS);
        person.undo = { timer, restore: outcome.removed, left: outcome.list.id };
      }
      // What the buttons show comes from the list the change saved, or found to be so already. One
      // found to be so by the person's say alone is the copy they were shown, with nothing saved:
      // it is no more known to be their newest for that, and is held as such a copy still, which
      // nothing else is told of and which is read for again.
      this.#hold(session, outcome.list, outcome.kind === "unchanged" && outcome.bySay === true);
      // The list was read afresh, and built on or found to be so already: by a read to trust (a
      // relay of the person's own answered, say), or by their say. What they were asked about
      // before, for anyone, was an earlier reading of it, and is let go of.
      session.asking = null;
      // Made by the person's say, on the copy they were shown, and confirmed: the list it saved is
      // one this tab made at their word and read back as the newest, and the next change may be
      // built on that very list with no second asking. Not for a change built on a read to trust,
      // of which they were asked nothing. And not for one that could not be checked: a relay may
      // have refused it as older than a list it holds, so this tab has been told its list may not
      // be the newest, and the person is asked again.
      if (outcome.kind === "saved" && outcome.bySay === true && outcome.confirmed) session.allowed = outcome.list.id;
    } else {
      // Not loaded, not kept, not approved or not saved. An Undo that ended so is offered still, with
      // what it puts back, for what is left of its ten seconds (ruling R22): they are not begun again.
      person.trouble = wrong(outcome.kind);
    }
    // What was just noted is held to the list too: a follow that failed of someone it names already.
    this.#agree(session);
    // The change kept the list it was built on, on its way: the copies may be one more.
    this.copies.written();
    this.#changed();
  }

  /**
   * A kept copy was put back and saved, in the session whose signal is `signal` (`OwnCopies`):
   * `list` is the person's list from here on, and what the buttons show comes from it. Nothing
   * when that session is over.
   */
  #wasPutBack(signal: AbortSignal, list: NostrEvent): void {
    const session = this.#session;
    if (session === null || session.stop.signal !== signal) return;
    this.#hold(session, list);
    // The list was replaced whole, at the person's word: what they were asked about was a copy of
    // the list before it, older than the one saved, and there is nothing left to ask.
    session.asking = null;
    this.#agree(session);
    this.#changed();
  }

  /**
   * Lets go of what the list held no longer agrees with, for everyone (ruling R27). The list is
   * replaced by each change the person makes, to anyone, and by a read: what was said of someone
   * before may not be so of them now.
   *
   * How a change went wrong: one that was not made (not loaded, not kept, not approved, not saved)
   * left the person as they were, so it is let go of once the list has them the other way, a
   * follow of someone it now names, an unfollow of someone it no longer does; it was made after
   * all, by a relay that took it without saying so, or in another app. One that was saved and not checked
   * left them as the change put them, so it is let go of once the list has them as they were
   * before. With it goes what Try again would do. And the offer of Undo, once the list names the
   * person again: there is nothing to put back. Nothing while the list is not known.
   *
   * And what the person is asked about, once the list held has them as that change would leave
   * them: named, for a follow or what Undo puts back; not named, for an unfollow. There is then
   * nothing to ask. So an asking is always for a change the button offers from the list held: a
   * follow's is never open under a button that says Following, nor an unfollow's under one that
   * says Follow.
   */
  #agree(session: Session): void {
    if (session.list === undefined) return;
    const { asking } = session;
    if (asking !== null && session.follows.has(asking.who) === (asking.action !== "unfollow")) session.asking = null;
    for (const [who, person] of session.people) {
      const named = session.follows.has(who);
      const { trouble } = person;
      if (trouble !== null) {
        const saved = trouble.how === "unconfirmed";
        const shouldBeNamed = (trouble.meant === "follow") === saved;
        if (named !== shouldBeNamed) person.trouble = null;
      }
      if (named) this.#endUndo(person);
    }
  }

  /** Ends the offer of Undo for `person`, if there is one, and forgets what it had to put back. */
  #endUndo(person: Person): void {
    clearTimeout(person.undo?.timer);
    person.undo = undefined;
  }

  /** Ends the session: stops what is under way for its person, and lets go of what was held for them. */
  #end(): void {
    const session = this.#session;
    if (session === null) return;
    this.#session = null;
    session.stop.abort(new DOMException("The person signed out, or someone else signed in", "AbortError"));
    for (const person of session.people.values()) clearTimeout(person.undo?.timer);
    // What this tab saw of their list is theirs: the next to sign in starts as in a tab just opened.
    forgetFollowFloor();
    this.#changed();
  }

  /** Notes a change to what a button or a page is told, and tells the listeners. */
  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

const FollowContext = createContext<OwnFollows | null>(null);

/**
 * Holds the follow list of the person signed in, for the buttons and pages below it (`useFollow`,
 * `useOwnFollowed`), and gives them the store of the copies kept of it in this browser, for the page
 * that lists them (`usePutBack`, ./keptStore.ts). It must be inside the account provider, whose
 * person it follows, and the scores provider, whose readers and writers it uses (`useRelays`): the
 * app's readers check each event's signature, as a follow list is anyone's to write in a person's
 * name. It reads nothing until a component below it uses one of the hooks while someone is signed
 * in, and it writes nothing: a tap goes through `changeFollow`, and a press of Put it back through
 * `putBackList`, which the copies' store calls. Signing out, someone else signing in, and the app
 * going away each stop what is under way and let go of what was held. While Follow is not open
 * (`config.features.follow`) it reads nothing at all, and no tap is a change.
 */
export function FollowProvider({ children }: { children: ReactNode }): JSX.Element {
  const { account } = useAccount();
  const relays = useRelays();
  const [store] = useState(() => new OwnFollows(relays));

  // Before the page is drawn, so that no button is drawn from another person's list.
  useLayoutEffect(() => store.setAccount(account), [store, account]);
  // The app going away: what is under way is stopped.
  useLayoutEffect(() => () => store.setAccount(undefined), [store]);

  return (
    <FollowContext value={store}>
      <CopiesContext value={store.copies}>{children}</CopiesContext>
    </FollowContext>
  );
}

/** For a tree with no `FollowProvider`: nothing to listen to. */
const listenToNothing = () => () => {};
const noVersion = () => 0;
const nobodyKnown = () => null;

/**
 * Whether the person signed in follows `pubkey` (64 hex digits, in either case), for a button, with
 * the taps that change it. Their list is read when a component first uses this or `useOwnFollowed`, and
 * until it has been the state is `unknown` (a read that could not tell is made again for a component
 * that appears `FOLLOW_REREAD_MS` after it, or later); a tap then is still a change, which reads the
 * list itself. When nobody is signed in, `pubkey` is no key, or there is no `FollowProvider` above, the
 * state is `unknown` and the taps do nothing.
 *
 * `asking` is set while the person is asked about a change to `pubkey` that could only be built on a
 * copy of their list found on the app's relays. `useThisCopy` is their answer, and makes that change:
 * call it from the press of Use this copy and from nothing else.
 */
export function useFollow(pubkey: string): FollowOf {
  const store = useContext(FollowContext);
  const version = useSyncExternalStore(store?.subscribe ?? listenToNothing, store?.version ?? noVersion);
  // A key in upper-case hex is the same person; what is no key names nobody.
  const who = useMemo(() => {
    const key = pubkey.toLowerCase();
    return isHex64(key) ? key : null;
  }, [pubkey]);

  const taps = useMemo(
    () => ({
      follow: () => who !== null && store?.change(who, "follow") === true,
      unfollow: () => {
        if (who !== null) store?.change(who, "unfollow");
      },
      undo: () => {
        if (who !== null) store?.undo(who);
      },
      retry: () => who !== null && store?.retry(who) === true,
      useThisCopy: () => who !== null && store?.useCopy(who) === true,
      notNow: () => {
        if (who !== null) store?.notNow(who);
      },
    }),
    [store, who],
  );

  return useMemo(() => {
    void version; // What the store tells changes with it.
    const told = store === null || who === null ? NOTHING_KNOWN : store.of(who);
    return { ...told, ...taps };
  }, [store, who, version, taps]);
}

/**
 * Who the person signed in follows, with whose list it is; null until it is read, when signed out,
 * and while what is held is a copy of their list they have not agreed to (the buttons alone draw
 * from that). For what reads other people's records from a person's list (who of them follows someone),
 * and so must know the list for that person's: when someone else signs in with no sign-out between,
 * the list of the person before is still held for the drawing the account changes in (the provider
 * is told of the account after it), and its `owner` says it is not theirs. A button needs no such
 * check: it is drawn again, from the next person's list or from none, before the page is shown.
 */
export function useOwnFollowed(): OwnFollowed | null {
  const store = useContext(FollowContext);
  return useSyncExternalStore(store?.subscribe ?? listenToNothing, store?.owned ?? nobodyKnown);
}

/**
 * Whether `from` and `to`, two paths in the app's address, are one page for what the Follow buttons
 * say of a change: the same path; or a place's page and the form that reviews it, either way round
 * (ruling R21). The form is the place's child route and opens over it, a dialog on a desktop, so
 * opening or closing it is not leaving the place. That pair and no other: two places, the forms of
 * two places, and any other two paths are two pages.
 */
export function sameVisit(from: string, to: string): boolean {
  return from === to || isFormOver(from, to) || isFormOver(to, from);
}

/**
 * Ends what the Follow buttons say of a change once the person goes to another page (ruling R19):
 * how one went wrong, and that a follow was just made, are for the visit they were said in. Another
 * path in the address is another page, but for a place's page and the form that reviews it
 * (`sameVisit`); what follows the path (a search, a section) is the same one.
 * For the shell, which is there on every page and inside the router: the provider is outside it, and
 * cannot ask where the person is. Before the new page is drawn, so that no button on it is drawn
 * with a line from the page before. Nothing where there is no `FollowProvider` above.
 */
export function useClearFollowLinesOnLeave(): void {
  const store = useContext(FollowContext);
  const { pathname } = useLocation();
  const shown = useRef(pathname);
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = pathname;
    if (!sameVisit(from, pathname)) store?.leftPage();
  }, [store, pathname]);
}
