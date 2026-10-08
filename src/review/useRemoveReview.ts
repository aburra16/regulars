import type { NostrEvent } from "@nostrify/nostrify";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AccountChanged, useAccount } from "../account/AccountProvider.tsx";
import type { Place } from "../places/place.ts";
import { REVIEW_KIND, type Review } from "../reviews/review.ts";
import { useRelays } from "../score/ScoresProvider.tsx";
import { useScoreActions } from "../score/useScore.ts";
import { NotPosted, type Posted, removalRelays, removeReview, sendReview, whereToPost } from "./post.ts";

/*
 * Removing the person's review of a place (M2b Task 7): asked first, then one removal of every version
 * of it (NIP-09), signed with their signer and sent where it went; hidden once a review relay takes it.
 */

/**
 * Where removing stands: nothing asked; asked (Remove, then Remove or Keep it); being removed; not
 * removed, said, with Try again; or removed, which the page says politely, its review gone.
 */
export type RemoveStatus = "idle" | "asking" | "removing" | "failed" | "removed";

/**
 * A removal signed and sent that no review relay took: the event, which reviews it names (their ids,
 * in order), where it was sent and where it was taken. Try again sends it again as it is, to the relays
 * that have not taken it, while it names the same reviews for the same person: nobody is asked to sign
 * it again.
 */
interface Unremoved {
  event: NostrEvent;
  ids: string;
  relays: readonly string[];
  accepted: readonly string[];
}

/** What the place's page does with the person's review of it, and where that stands. */
export interface RemoveReview {
  status: RemoveStatus;
  /** Whether the person is signed in, with a signer to sign the removal: not while a kept session is restored. */
  ready: boolean;
  /** Remove: asks first. */
  ask(): void;
  /** Keep it: leaves it as it is. */
  keep(): void;
  /** Remove, once asked; Try again, after it failed. */
  remove(): void;
}

/**
 * Removing `mine`, the person's review of `place`, from its page. Removing names every version of
 * their review of the place, under any `d` and in any filing (`ownCoordinates`), in one removal that
 * their signer signs; it goes to the review relays, where they write now and where each version went
 * (`removalRelays`). Once a review relay takes it, each is hidden at once, and kept hidden from a relay
 * that lags (`noteRemoval`); their own relays may still be answering. When no review relay takes it,
 * it says so, and Try again sends the same removal again. A person whose add-on or phone app now signs
 * as someone else (they are signed out, `AccountChanged`) is sent to sign in, and back to the place.
 * Leaving the page stops it, until a review relay has taken it.
 */
export function useRemoveReview(place: Place, mine: Review | undefined): RemoveReview {
  const { account } = useAccount();
  const { readers, writers } = useRelays();
  const { noteRemoval, ownCoordinates } = useScoreActions();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState<RemoveStatus>("idle");
  /** Aborts what is under way when the page goes. */
  const life = useRef<AbortController | null>(null);
  /** Whether a removal is under way: a second press before the page has redrawn removes nothing more. */
  const busy = useRef(false);
  /** The last removal signed that no review relay took, for Try again. */
  const unremoved = useRef<Unremoved | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort(new DOMException("The place's page was closed", "AbortError"));
  }, []);

  // Another review of theirs (they edited it, or rated the place again after removing one): what was
  // asked, or said, was of the last one. While one is being removed, that goes on.
  const mineId = mine?.id;
  useEffect(() => {
    if (mineId !== undefined) setStatus((now) => (now === "removing" ? now : "idle"));
  }, [mineId]);

  const remove = async () => {
    const signal = life.current?.signal;
    if (busy.current || signal === undefined || account === undefined) return;
    const reviews = ownCoordinates(account.pubkey, place.address);
    if (reviews.length === 0) return;
    busy.current = true;
    setStatus("removing");
    const ids = reviews.map((review) => review.id).join();
    const again = unremoved.current;
    const resend = again !== null && again.event.pubkey === account.pubkey && again.ids === ids;
    /** Where it is sent, and where it was taken already (by an earlier try). */
    let relays: readonly string[] = [];
    const before = resend ? again.accepted : [];
    try {
      let removed: Posted;
      if (resend) {
        relays = again.relays;
        removed = await sendReview(again.event, relays.filter((url) => !before.includes(url)), signal, { writers });
      } else {
        unremoved.current = null;
        relays = removalRelays(await whereToPost(account.pubkey, account.signer, readers, signal), reviews);
        removed = await removeReview(reviews, account, relays, Math.floor(Date.now() / 1000), signal, { writers });
      }
      unremoved.current = null;
      for (const review of reviews) noteRemoval(`${REVIEW_KIND}:${account.pubkey}:${review.d}`, removed.event.created_at);
      setStatus("removed");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AccountChanged) {
        void navigate("/signin", { state: { from: location } });
        return;
      }
      if (error instanceof NotPosted && error.event !== undefined) {
        unremoved.current = { event: error.event, ids, relays, accepted: [...before, ...error.accepted] };
      }
      setStatus("failed");
    } finally {
      busy.current = false;
    }
  };

  return {
    status,
    ready: account !== undefined,
    ask: () => setStatus((now) => (now === "removing" ? now : "asking")),
    keep: () => setStatus((now) => (now === "removing" ? now : "idle")),
    remove: () => void remove(),
  };
}
