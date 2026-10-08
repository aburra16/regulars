import { readSession } from "../account/session.ts";
import { isHex64 } from "../nostr/shapes.ts";

/*
 * The token Brainstorm gives a person once they have signed its login (./brainstorm.ts): a JWT that
 * lasts about an hour, which the app cannot renew. A request it is refused with (401) means it has
 * expired; the app does not read its expiry. It is kept in `sessionStorage`, which the browser
 * clears when the tab is closed, and never in `localStorage`, an address or a log (Global
 * Constraints, Token). It is the person's alone: it is read back only while the tab's session is
 * theirs, so once they sign out of the tab it is not read again, and goes.
 */

/** Where the token is kept, with the public key of the person it is for. */
export const TOKEN_KEY = "regulars.brainstorm";

/** A JWT as Brainstorm writes one: three base64url parts, joined by dots. Kept to a sane length. */
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Whether `value` reads as a token Brainstorm gives. */
export function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096 && JWT.test(value);
}

/** What is kept in `TOKEN_KEY`, from its JSON, or null when it is not what this module writes. */
function asKept(value: unknown): { pubkey: string; token: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { pubkey, token } = value as Record<string, unknown>;
  return typeof pubkey === "string" && isHex64(pubkey) && isToken(token) ? { pubkey, token } : null;
}

/**
 * The token this tab keeps for `pubkey`, or null: when there is none, it is another person's, or
 * the tab's session is not theirs (they signed out, or someone else signed in). One kept for someone
 * who is no longer signed in to the tab, or written any way this module does not, is forgotten.
 */
export function readToken(pubkey: string): string | null {
  let text: string | null;
  try {
    text = window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Storage that is blocked keeps nothing.
    return null;
  }
  if (text === null) return null;
  let kept: { pubkey: string; token: string } | null = null;
  try {
    kept = asKept(JSON.parse(text));
  } catch {
    kept = null;
  }
  if (kept === null || readSession()?.pubkey !== kept.pubkey) {
    forgetToken();
    return null;
  }
  return kept.pubkey === pubkey ? kept.token : null;
}

/** Keeps `token` for `pubkey` in this tab, in place of any kept before. Where storage is blocked or full, nothing is kept. */
export function saveToken(pubkey: string, token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ pubkey, token }));
  } catch {
    // Blocked or full: the person signs Brainstorm's login again next time.
  }
}

/** Forgets the token this tab keeps: for signing out, and for one Brainstorm says has expired. */
export function forgetToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Blocked: there is nothing kept to forget.
  }
}
