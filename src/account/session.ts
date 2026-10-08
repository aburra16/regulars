import type { NostrSigner } from "@nostrify/nostrify";

import { isHex64 } from "../nostr/shapes.ts";
import { publicRelayAddress } from "./writeRelays.ts";

/*
 * Who is signed in, and what this tab keeps of it. The person's own key is never here, or anywhere in
 * the app (docs/decisions.md #21): they sign with a browser add-on (NIP-07) or an app on their phone
 * (NIP-46), and the app holds only a signer that asks one of them. This module loads nothing of
 * Nostrify, so the first screen can read the session before the signing code (./connect.ts) arrives.
 */

/** How the person signs: with an add-on in this browser, or with an app on their phone. */
export type How = "browser" | "phone";

/** The person who has signed in: their public key, and the signer that asks their add-on or app. */
export interface Account {
  pubkey: string;
  signer: NostrSigner;
  how: How;
}

/**
 * What this tab keeps of a session, so that a reload in it does not ask again. For a phone, the
 * connection to its app: the key the app made for this connection alone (`appKey`, hex), which is
 * not the person's and signs nothing of theirs, the phone app's key (`signerPubkey`) and where they
 * meet (`relay`). The person's own public key, which is not secret, in both.
 */
export type Session =
  | { how: "browser"; pubkey: string }
  | { how: "phone"; pubkey: string; signerPubkey: string; relay: string; appKey: string };

/**
 * Where the session is kept: `sessionStorage`, which the browser clears when the tab is closed, and
 * never `localStorage`, an address or a log (Global Constraints, Keys).
 */
export const SESSION_KEY = "regulars.account";

/** The session in `value`, as JSON from storage, or null if it is not one this app wrote. */
function asSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const { how, pubkey, signerPubkey, relay, appKey } = value as Record<string, unknown>;
  if (typeof pubkey !== "string" || !isHex64(pubkey)) return null;
  if (how === "browser") return { how, pubkey };
  if (how !== "phone") return null;
  if (typeof signerPubkey !== "string" || !isHex64(signerPubkey)) return null;
  if (typeof appKey !== "string" || !isHex64(appKey)) return null;
  // Only a public wss:// meeting point, as the app's own (config.connectRelay) is and a pasted link's must be.
  const at = publicRelayAddress(relay);
  if (at === null) return null;
  return { how, pubkey, signerPubkey, relay: at, appKey };
}

/**
 * The session this tab keeps, or null when there is none. One that is not the app's own shape (an
 * older version's, or one changed by hand) is forgotten, and the person starts signed out.
 */
export function readSession(): Session | null {
  let text: string | null;
  try {
    text = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Storage that is blocked keeps nothing.
    return null;
  }
  if (text === null) return null;
  let session: Session | null = null;
  try {
    session = asSession(JSON.parse(text));
  } catch {
    session = null;
  }
  if (session === null) forgetSession();
  return session;
}

/** Keeps `session` for this tab. Where storage is blocked or full, it lasts until the page is reloaded. */
export function saveSession(session: Session): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Blocked or full: the person stays signed in until the page is reloaded.
  }
}

/** Forgets the session this tab keeps. */
export function forgetSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Blocked: there is nothing kept to forget.
  }
}
