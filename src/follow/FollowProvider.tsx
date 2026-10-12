import type { NostrEvent } from "@nostrify/nostrify";
import { createContext, type JSX, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { isNewer } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { isFormOver } from "../review/paths.ts";
import { type Relays, useRelays } from "../score/ScoresProvider.tsx";
import { changeFollow, type FollowOutcome, forgetFollowFloor, raiseFollowFloor } from "./change.ts";
import { followed, type Removed } from "./list.ts";
import { followRelaysWith, newListQuorum, readOwnList } from "./read.ts";

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
 * one of those changes that was not made) and at no other time. Nothing here is logged: a list, its
 * entries and the relays a person keeps it on are theirs.
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
 * While Follow is not open (`config.features.follow`, ruling R39) none of this happens: nothing is
 * known of anyone, no relay is asked anything, and a tap is no change. The store holds itself to
 * that (`OwnFollows`), whatever a component that uses it does.
 */

/**
 * What a button for a person shows:
 * - `unknown`: nobody is signed in, or the list of the person who is has not been read, or could not
 *   be: no button says Follow or Following, as either might be wrong;
 * - `not-following`, `following`: as the list has it;
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
  trouble: "not-loaded" | "not-approved" | "not-saved" | "unconfirmed" | null;
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
   * Follows the person: for a tap of Follow. While Undo is offered for them it is that Undo, which
   * puts them back as they were (ruling R28). Nothing while a change to them is under way, or nobody
   * is signed in. Whether it began a plain follow: one that adds them to the list, which the last
   * update of the person's circle did not count. Not an Undo, which adds nobody, and not a tap that
   * began nothing. The button asks, and does not work it out from what it shows (ruling R24).
   */
  follow(): boolean;
  /** Unfollows the person: for a press of Unfollow, which the button says before it unfollows. Nothing while a change to them is under way, or nobody is signed in. */
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
type Told = Pick<FollowOf, "state" | "trouble" | "canUndo" | "justFollowed">;

/** What every button is told while nobody is signed in. */
const NOTHING_KNOWN: Told = { state: "unknown", trouble: null, canUndo: false, justFollowed: false };

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

/** What is held for the person signed in, from their sign-in until they sign out or someone else signs in. */
interface Session {
  /** The person, with the signer their changes are signed with. */
  account: Account;
  /** Aborts when the session ends, and at no other time: the read of the list and every change are made on its signal. */
  stop: AbortController;
  /** Their follow list: undefined until it is read, null once it is known that they have none. */
  list: NostrEvent | null | undefined;
  /** Who `list` names: null until it is read. The same array until the list changes. */
  followed: readonly string[] | null;
  /** The same keys with whose list they are (`useOwnFollowed`): null until it is read. The same object for as long as `followed` is the same array. */
  owned: OwnFollowed | null;
  /** The same keys, for a button's question of one person: made once when the list is held, so that an answer takes no longer for a long list. */
  follows: ReadonlySet<string>;
  /** Whether the list is being read. */
  reading: boolean;
  /**
   * When the last read that left the list unknown ended; undefined until one has. No read is begun
   * for `FOLLOW_REREAD_MS` from then. By the clock that only goes forward (`performance.now()`), not
   * the device's date, which can be set: put back, it would keep the list unread for as long as it
   * was put back by.
   */
  unread: number | undefined;
  /** The people a button was tapped for, by key. */
  people: Map<string, Person>;
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
 * when as many of the app's follow-list relays answered as a first list needs (`newListQuorum`, more
 * than half of them and no fewer than three). One relay's nothing proves nothing, as some keep no
 * lists, and a button that said Follow of someone the person follows would be wrong. The person's
 * own relays do not make up the number.
 */
function followsNobody(answered: readonly string[]): boolean {
  const ours = new Set(followRelaysWith(null).relays);
  return answered.filter((url) => ours.has(url)).length >= newListQuorum(ours.size);
}

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

  constructor(relays: Relays) {
    this.#relays = relays;
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
   * is for. Null until their list is read, and when nobody is signed in. The same object until the
   * list changes.
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
          followed: null,
          owned: null,
          follows: new Set(),
          reading: false,
          unread: undefined,
          people: new Map(),
        };
      }
    }
    this.#readIfShown();
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
    };
  }

  /**
   * The person signed in has gone to another page. What a change left to say was for the page it
   * was said on (ruling R19): how one went wrong, and that a follow was just made, are let go of,
   * for everyone. Not Undo, which has its ten seconds wherever the person goes; and not a change
   * under way, whose end is told on the page they are on by then.
   */
  leftPage(): void {
    const session = this.#live();
    if (session === null) return;
    let said = false;
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
   */
  change(who: string, action: "follow" | "unfollow"): boolean {
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
   */
  retry(who: string): boolean {
    const trouble = this.#live()?.people.get(who)?.trouble;
    return trouble !== undefined && trouble !== null && trouble.how !== "unconfirmed" && this.change(who, trouble.meant);
  }

  /**
   * Starts a change to `who`'s place in the list, on a tap, unless one is under way, nobody is signed
   * in, or Follow is not open. Whether it started one.
   */
  #start(who: string, action: Action): boolean {
    const session = this.#live();
    if (session === null) return false;
    const person: Person = session.people.get(who) ?? { saving: false, trouble: null, justFollowed: false, undo: undefined };
    session.people.set(who, person);
    if (person.saving) return false;
    person.saving = true;
    // The tap ends what the last change left to say. A tap of Follow or Unfollow ends its Undo too,
    // with what that had to put back; a tap of Undo keeps both until it is known to have saved, as
    // one that did not is tapped again (ruling R22).
    person.trouble = null;
    person.justFollowed = false;
    if (!isUndo(action)) this.#endUndo(person);
    this.#changed();

    // The session's signal, and no other: it aborts when the person signs out or someone else signs
    // in, and when the app goes away. Not when the change has ended, nor when its button has gone:
    // slower relays are still being sent the list on it then (`FOLLOW_SETTLE_MS`, ./change.ts).
    const { readers, writers } = this.#relays;
    changeFollow(session.account, who, action, { readers, writers }, session.stop.signal).then(
      (outcome) => this.#over(session, person, action, outcome),
      () => this.#over(session, person, action, null),
    );
    return true;
  }

  /**
   * Reads the list when a component shows it, someone is signed in, and it is neither known nor being
   * read. Not within `FOLLOW_REREAD_MS` of a read that left it unknown: it is a wait and no more, with
   * no timer, so a page that stays open is not read for again, and the first button to appear once
   * the wait is over has the list read. A new session has no wait. A tap is not held up by it: a
   * change reads the list itself. Nothing while Follow is not open.
   */
  #readIfShown(): void {
    const session = this.#live();
    if (session === null || this.#listeners.size === 0 || session.list !== undefined || session.reading) return;
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
   * `FOLLOW_REREAD_MS` have passed has it read again. What a read that is not trusted found is
   * neither shown nor taken for the newest list this tab has seen.
   */
  async #read(session: Session): Promise<void> {
    const { pubkey } = session.account;
    const { signal } = session.stop;
    const { readers } = this.#relays;
    try {
      const { list, answered, trusted } = await readOwnList(pubkey, readers, signal);
      if (this.#session !== session || !trusted) return;
      // The list on screen from here on: a change is never built on one older than it (ruling R18).
      if (list !== null) raiseFollowFloor(pubkey, list);
      if ((list !== null || followsNobody(answered)) && this.#hold(session, list)) this.#changed();
    } catch {
      // Stopped (the person signed out, or someone else signed in), or something unexpected went
      // wrong: a relay that fails or is slow is not thrown for. Either way nothing of it is kept: the
      // list stays unknown, and no button says Follow or Following.
    } finally {
      session.reading = false;
      // Still unknown, however the read ended: it is not read again for a while. (A session that
      // has ended is asked nothing more, so what is noted of it is never looked at.)
      if (session.list === undefined) session.unread = performance.now();
    }
  }

  /**
   * Holds `list` as the session's person's (null: they have none), unless a newer one is held: a
   * read that ends after a change has saved a newer list does not put the older one back. What was
   * said of anyone that the list no longer agrees with is let go of (`#agree`). Whether what is held
   * changed; the caller tells the listeners.
   */
  #hold(session: Session, list: NostrEvent | null): boolean {
    const held = session.list;
    if (held === null && list === null) return false;
    if (held !== undefined && held !== null && (list === null || !isNewer(list, held))) return false;
    session.list = list;
    session.followed = Object.freeze(followed(list));
    session.owned = Object.freeze({ owner: session.account.pubkey.toLowerCase(), followed: session.followed });
    session.follows = new Set(session.followed);
    this.#agree(session);
    return true;
  }

  /**
   * A change has ended: `outcome` is how, or null when it failed in a way `changeFollow` has no name
   * for. Nothing of it is kept when its session is over (the person signed out, or someone else
   * signed in): it was given up.
   */
  #over(session: Session, person: Person, action: Action, outcome: FollowOutcome | null): void {
    if (this.#session !== session) return;
    person.saving = false;
    // What the change meant to do, for Try again: Undo is a follow, of the kind that puts back.
    const meant = action === "unfollow" ? "unfollow" : "follow";
    if (outcome === null) {
      // Not a change given up, as its session goes on. Nothing `changeFollow` does once it has sent a
      // list fails so, so no list was saved. An Undo that ended so is offered still (ruling R22).
      person.trouble = { how: "not-saved", meant };
    } else if (outcome.kind === "saved" || outcome.kind === "unchanged") {
      if (outcome.kind === "saved" && !outcome.confirmed) person.trouble = { how: "unconfirmed", meant };
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
      // What the buttons show comes from the list the change saved, or found to be so already.
      this.#hold(session, outcome.list);
    } else {
      // Not loaded, not approved or not saved. An Undo that ended so is offered still, with what it
      // puts back, for what is left of its ten seconds (ruling R22): they are not begun again.
      person.trouble = { how: outcome.kind, meant };
    }
    // What was just noted is held to the list too: a follow that failed of someone it names already.
    this.#agree(session);
    this.#changed();
  }

  /**
   * Lets go of what the list held no longer agrees with, for everyone (ruling R27). The list is
   * replaced by each change the person makes, to anyone, and by a read: what was said of someone
   * before may not be so of them now.
   *
   * How a change went wrong: one that was not made (not loaded, not approved, not saved) left the
   * person as they were, so it is let go of once the list has them the other way, a follow of
   * someone it now names, an unfollow of someone it no longer does; it was made after all, by a
   * relay that took it without saying so, or in another app. One that was saved and not checked
   * left them as the change put them, so it is let go of once the list has them as they were
   * before. With it goes what Try again would do. And the offer of Undo, once the list names the
   * person again: there is nothing to put back. Nothing while the list is not known.
   */
  #agree(session: Session): void {
    if (session.list === undefined) return;
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
 * `useOwnFollowed`). It must be inside the account provider, whose person it follows, and the scores
 * provider, whose readers and writers it uses (`useRelays`): the app's readers check each event's
 * signature, as a follow list is anyone's to write in a person's name. It reads nothing until a
 * component below it uses one of the hooks while someone is signed in, and it writes nothing: a tap
 * goes through `changeFollow`. Signing out, someone else signing in, and the app going away each
 * stop what is under way and let go of what was held. While Follow is not open
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

  return <FollowContext value={store}>{children}</FollowContext>;
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
 * Who the person signed in follows, with whose list it is; null until it is read, and when signed
 * out. For what reads other people's records from a person's list (who of them follows someone),
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
