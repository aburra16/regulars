import { type Paid, PAID_WAYS, type Price } from "../reviews/review.ts";
import type { WholeStars } from "../reviews/write.ts";

/*
 * What a person has chosen and typed into the review form so far, kept for this tab as they type it:
 * a reload, the form drawn again when the window crosses 900 px (a phone turned, a window resized), or
 * a trip to sign in (they were signed out, or their add-on or phone app had changed accounts, ruling
 * R12) comes back to it. One draft, of one place, for one person; posting the review, or closing the
 * form, forgets it. It holds only what they acted on: what they did not is filled from their own
 * review wherever the form comes back, and kept from it in an edit.
 */

/** Where the draft is kept: `sessionStorage`, gone when the tab closes. */
export const DRAFT_KEY = "regulars.reviewDraft";

/**
 * What the person has given in the review form: each field they have acted on, and none they have not
 * (undefined: not touched). The stars once they chose some; the words once they edited them at all, so
 * that empty words are words they cleared; the price and how they paid as `Given` gives them
 * (src/reviews/write.ts), the one chosen or null once cleared. A field acted on touches no other.
 */
export interface Draft {
  stars?: WholeStars;
  text?: string;
  price?: Price | null;
  paid?: Paid | null;
}

const isWhole = (value: unknown): value is WholeStars => value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

/** Whether `value` is a price as the draft keeps it: one from 1 to 4, null (cleared), or not there (not touched). */
const isPriceKept = (value: unknown): value is Price | null | undefined =>
  value === undefined || value === null || value === 1 || value === 2 || value === 3 || value === 4;

/** Whether `value` is a way they paid as the draft keeps it: one of `PAID_WAYS`, null (cleared), or not there (not touched). */
const isPaidKept = (value: unknown): value is Paid | null | undefined =>
  value === undefined || value === null || PAID_WAYS.some((way) => way === value);

/**
 * The draft of the review of the place at `address` that the tab keeps for `pubkey`, the person signed
 * in (or about to be): one they typed, or one typed before signing in, which is for whoever signs in
 * next. Undefined for any other place or person, when there is none, or when storage is blocked. A
 * field it does not hold is not touched, nor are stars it holds as null (none chosen); words it holds
 * were typed, even empty ones.
 */
export function readDraft(address: string, pubkey: string | undefined): Draft | undefined {
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) return undefined;
    const { address: of, pubkey: by, stars, text, price, paid } = kept as Record<string, unknown>;
    if (of !== address || (text !== undefined && typeof text !== "string")) return undefined;
    if (stars !== undefined && stars !== null && !isWhole(stars)) return undefined;
    if (!isPriceKept(price) || !isPaidKept(paid)) return undefined;
    if (by !== null && (typeof by !== "string" || by !== pubkey)) return undefined;
    return { stars: isWhole(stars) ? stars : undefined, text, price, paid };
  } catch {
    return undefined;
  }
}

/**
 * Keeps `draft` of the review of the place at `address`, in place of any other: `pubkey`'s, or, with
 * none, for whoever signs in next (the form sends a person to sign in with what they typed). A field
 * not touched is left out, and so reads back as not touched.
 */
export function saveDraft(address: string, draft: Draft, pubkey: string | undefined): void {
  try {
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ address, pubkey: pubkey ?? null, stars: draft.stars, text: draft.text, price: draft.price, paid: draft.paid }),
    );
  } catch {
    // Blocked or full: the person types it again.
  }
}

/** Forgets the draft. */
export function dropDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Blocked: nothing is kept to forget.
  }
}
