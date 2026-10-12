import * as nip19 from "nostr-tools/nip19";

import { isHex64 } from "../nostr/shapes.ts";

/*
 * A person in the app's address: `/person/<npub>`, where the npub is their public key as other apps
 * write it for people to pass around. The code is nostr-tools' (`nip19`): nothing here encodes or
 * decodes by hand. A leaf, which a link to a person's page can import without the page's own code.
 */

/**
 * `pubkey` (64 hex digits, in either case) as an npub. Throws for anything that is no public key:
 * the app's own reviews and lists carry keys that were checked as they were read.
 */
export function toNpub(pubkey: string): string {
  const key = pubkey.toLowerCase();
  if (!isHex64(key)) throw new Error("Not a public key: 64 hex digits expected");
  return nip19.npubEncode(key);
}

/**
 * The public key an npub names, in lower-case hex; null for anything that is not the npub of a key
 * of 64 hex digits: another kind of code (a note's, a secret key's, a profile's), a key in hex, a
 * code that is cut short or mistyped, or one with anything before or after it. A code written all in
 * upper case is the same code.
 */
export function fromNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === "npub" && isHex64(decoded.data) ? decoded.data : null;
  } catch {
    // Not a code at all, or one whose check does not hold.
    return null;
  }
}

/** The address of a person's page, by their public key (64 hex digits, in either case): `/person/<npub>`. */
export const personPath = (pubkey: string): string => `/person/${toNpub(pubkey)}`;
