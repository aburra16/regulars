import type { WholeStars } from "../reviews/write.ts";

/*
 * What a person has chosen and typed into the review form so far, kept for this tab as they type it:
 * a reload, the form drawn again when the window crosses 900 px (a phone turned, a window resized), or
 * a trip to sign in (they were signed out, or their add-on or phone app had changed accounts, ruling
 * R12) comes back to it. One draft, of one place, for one person; posting the review, or closing the
 * form, forgets it.
 */

/** Where the draft is kept: `sessionStorage`, gone when the tab closes. */
export const DRAFT_KEY = "regulars.reviewDraft";

/** The stars chosen, if any, and the words typed. */
export interface Draft {
  stars: WholeStars | undefined;
  text: string;
}

const isWhole = (value: unknown): value is WholeStars => value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

/**
 * The draft of the review of the place at `address` that the tab keeps for `pubkey`, the person signed
 * in (or about to be): one they typed, or one typed before signing in, which is for whoever signs in
 * next. Undefined for any other place or person, when there is none, or when storage is blocked.
 */
export function readDraft(address: string, pubkey: string | undefined): Draft | undefined {
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) return undefined;
    const { address: of, pubkey: by, stars, text } = kept as Record<string, unknown>;
    if (of !== address || typeof text !== "string" || (stars !== undefined && stars !== null && !isWhole(stars))) return undefined;
    if (by !== null && (typeof by !== "string" || by !== pubkey)) return undefined;
    return { stars: isWhole(stars) ? stars : undefined, text };
  } catch {
    return undefined;
  }
}

/**
 * Keeps `draft` of the review of the place at `address`, in place of any other: `pubkey`'s, or, with
 * none, for whoever signs in next (the form sends a person to sign in with what they typed).
 */
export function saveDraft(address: string, draft: Draft, pubkey: string | undefined): void {
  try {
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ address, pubkey: pubkey ?? null, stars: draft.stars ?? null, text: draft.text }),
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
