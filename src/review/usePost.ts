import type { NostrEvent } from "@nostrify/nostrify";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AccountChanged, useAccount } from "../account/AccountProvider.tsx";
import type { Place } from "../places/place.ts";
import { reviewTemplate, type WholeStars } from "../reviews/write.ts";
import { useRelays } from "../score/ScoresProvider.tsx";
import { useScoreActions } from "../score/useScore.ts";
import { dropDraft, saveDraft } from "./draft.ts";
import { NotPosted, type Posted, postReview, reviewStamp, sendReview, signTimeFor, whereToPost } from "./post.ts";

/*
 * Posting the review form (screen 8, D3): kept above the form, by the review's route, so that a form
 * drawn again keeps it. Crossing 900 px (a phone turned, a window resized) draws the form the other
 * way, a page or a dialog, as a new one: a post under way goes on, and the new form says where it
 * stands. Closing the form (its way back, its cross, Escape, or going elsewhere) stops it.
 */

/**
 * Where a post stands: none yet (the form is being filled in), being posted, or not posted (said, with
 * what was typed kept): not at all, or only to the person's own relays and not to Regulars (ruling R13).
 */
export type PostStatus = "editing" | "posting" | "failed" | "not on Regulars";

/** The form's post: where it stands, and how to post. */
export interface Posting {
  status: PostStatus;
  /** Posts a review of `stars` with the words `text`; nothing while one is under way. */
  post(stars: WholeStars, text: string): void;
}

/**
 * A review signed and sent that no review relay took: the event, the stars it gives, where it was sent
 * and where it was taken. Try again sends it again as it is, to the relays that have not taken it,
 * while the form still says what it says, for the same person: nobody is asked to sign it again.
 */
interface Unposted {
  event: NostrEvent;
  stars: WholeStars;
  relays: readonly string[];
  accepted: readonly string[];
}

/**
 * Posting a review of `place` for the person who has signed in. Posting signs the review with the
 * person's signer (an add-on within `SIGN_TIMEOUT_MS`) and sends it where they publish (`whereToPost`,
 * `postReview`); once a relay Regulars reads reviews from has taken it, the place shows it at once,
 * held until the relays send it back (`noteOwnReview`), the draft is forgotten, and `onPosted` takes
 * the person back to the place, while their own relays may still be answering. When no such relay
 * takes it, the status says so (and whether the person's own relays did); Try again sends the same
 * signed review again while the stars and words are the same, and signs a new one when they are not.
 * A person who is signed out, or whose add-on or phone app now signs as someone else (they are signed
 * out, `AccountChanged`), is sent to sign in, and back to the form with what they typed.
 */
export function usePost(place: Place, onPosted: () => void): Posting {
  const { account } = useAccount();
  const { readers, writers } = useRelays();
  const { noteOwnReview, ownCoordinates, ownRemovedAt } = useScoreActions();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState<PostStatus>("editing");
  /** Aborts what is under way when the form's route goes. */
  const life = useRef<AbortController | null>(null);
  /** Whether a post is under way: a second press before the page has redrawn posts nothing more. */
  const busy = useRef(false);
  /** The last review signed that no review relay took, for Try again. */
  const unposted = useRef<Unposted | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort(new DOMException("The review form was closed", "AbortError"));
  }, []);

  /**
   * To sign in, and back to the form with what was typed: kept for whoever signs in next in this tab,
   * the person at the keyboard, whose add-on may have changed accounts.
   */
  const toSignIn = (stars: WholeStars, text: string) => {
    saveDraft(place.address, { stars, text }, undefined);
    void navigate("/signin", { state: { from: location } });
  };

  const post = async (stars: WholeStars, text: string) => {
    const signal = life.current?.signal;
    if (busy.current || signal === undefined) return;
    if (account === undefined) return toSignIn(stars, text);
    busy.current = true;
    setStatus("posting");
    const words = text.trim();
    const again = unposted.current;
    const resend = again !== null && again.event.pubkey === account.pubkey && again.stars === stars && again.event.content === words;
    /** Where it is sent, and where it was taken already (by an earlier try). */
    let relays: readonly string[] = [];
    const before = resend ? again.accepted : [];
    try {
      let posted: Posted;
      if (resend) {
        relays = again.relays;
        posted = await sendReview(again.event, relays.filter((url) => !before.includes(url)), signal, { writers });
      } else {
        unposted.current = null;
        relays = await whereToPost(account.pubkey, account.signer, readers, signal);
        const now = Math.floor(Date.now() / 1000);
        const stamp = reviewStamp(now, ownCoordinates(account.pubkey, place.address), ownRemovedAt(account.pubkey, place.address));
        posted = await postReview(reviewTemplate(place, stars, words, stamp), account.signer, [...relays], signal, {
          writers,
          signWithin: signTimeFor(account.how),
        });
      }
      unposted.current = null;
      // Held with every relay it was sent to, so that removing it goes there too: one that has not
      // answered yet, or did not in time, may keep it all the same (Task 7, ruling R17).
      noteOwnReview(posted.event, relays);
      dropDraft();
      onPosted();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AccountChanged) return toSignIn(stars, text);
      const taken = error instanceof NotPosted ? [...before, ...error.accepted] : [];
      if (error instanceof NotPosted && error.event !== undefined) {
        unposted.current = { event: error.event, stars, relays, accepted: taken };
      }
      setStatus(taken.length > 0 ? "not on Regulars" : "failed");
    } finally {
      busy.current = false;
    }
  };

  return {
    status,
    post: (stars, text) => {
      void post(stars, text);
    },
  };
}
