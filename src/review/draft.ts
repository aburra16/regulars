import type { WholeStars } from "../reviews/write.ts";

/*
 * What a person had typed into the review form when it sent them to sign in (they were signed out, or
 * their add-on or phone app had changed accounts, ruling R12): kept for this tab, so that the form
 * they come back to has it. One draft, of one place; posting the review, or closing the form, forgets it.
 */

/** Where the draft is kept: `sessionStorage`, gone when the tab closes. */
export const DRAFT_KEY = "regulars.reviewDraft";

/** The stars chosen, if any, and the words typed. */
export interface Draft {
  stars: WholeStars | undefined;
  text: string;
}

const isWhole = (value: unknown): value is WholeStars => value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

/** The draft of the review of the place at `address`, if the tab keeps one; undefined otherwise. */
export function readDraft(address: string): Draft | undefined {
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) return undefined;
    const { address: of, stars, text } = kept as Record<string, unknown>;
    if (of !== address || typeof text !== "string" || (stars !== undefined && stars !== null && !isWhole(stars))) return undefined;
    return { stars: isWhole(stars) ? stars : undefined, text };
  } catch {
    return undefined;
  }
}

/** Keeps `draft` of the review of the place at `address`, in place of any other. */
export function saveDraft(address: string, draft: Draft): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ address, stars: draft.stars ?? null, text: draft.text }));
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
