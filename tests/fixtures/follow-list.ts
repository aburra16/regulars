import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent } from "nostr-tools/pure";

/*
 * A synthetic follow list (kind 3) of 1,200 entries, for the tests of the list's rules and of the
 * change that writes it. No real person's list is in the repo. Every public key in it is made from a
 * number (`pubkeyAt`), so it is the same each time and belongs to nobody; only its author's key is
 * the caller's, so that a test can sign in as the author.
 *
 * It has the shapes old and new clients write: `p` tags with nothing after the key, with a relay
 * hint, with a hint and a petname, and with a petname alone; tags that are not `p` tags; one person
 * named twice (once plainly, once with a hint and petname); one named in upper-case hex; entries
 * that are not follows at all (too short, not hex, the wrong length, empty); and, as old clients
 * wrote, a `content` that is a JSON map of relays.
 */

/** How many tags the list has: `p` tags, other tags and malformed ones all counted. */
export const FOLLOW_LIST_SIZE = 1_200;

/** The time the list is made at unless a test says another, in seconds since the epoch. */
export const FOLLOW_LIST_TIME = 1_700_000_000;

/** The `content` of the list: a map of relays, as old clients wrote. */
export const FOLLOW_LIST_CONTENT = JSON.stringify({
  "wss://relay.example.test": { read: true, write: true },
  "wss://nos.example.test": { read: true, write: false },
});

/** A 64-digit lower-case hex public key made from `index`, the same each time and belonging to nobody. */
export function pubkeyAt(index: number): string {
  return (0xf011_0000 + index).toString(16).padStart(64, "0");
}

/** The relay hint some entries carry. */
const HINT = "wss://relay.example.test";

/** The person the list names twice, at `DUPLICATE_AT` plainly and at `DUPLICATE_AGAIN_AT` with a hint and a petname. */
export const DUPLICATED = pubkeyAt(10_000);
export const DUPLICATE_AT = 150;
export const DUPLICATE_AGAIN_AT = 900;

/** The person the list names in upper-case hex, at `UPPER_CASE_AT`; `UPPER_CASED` is that spelling. */
export const UPPER_CASE_KEY = pubkeyAt(10_001);
export const UPPER_CASED = UPPER_CASE_KEY.toUpperCase();
export const UPPER_CASE_AT = 400;

/** A person the list does not name. */
export const ABSENT = pubkeyAt(20_000);

/** The tags that are not `p` tags, by place in the list. */
const OTHER_TAGS = new Map<number, string[]>([
  [7, ["e", "e".repeat(64), HINT]],
  [23, ["client", "synthetic-client"]],
  [610, ["e", "d".repeat(64), "", "reply"]],
]);

/** The entries that are not follows, by place in the list. */
const MALFORMED_TAGS = new Map<number, string[]>([
  [31, ["p"]],
  [32, ["p", "not-a-key"]],
  [33, ["p", "z".repeat(64)]],
  [34, ["p", ""]],
  [35, ["p", pubkeyAt(1).slice(1)]],
  [36, []],
]);

/** The tags, and the keys they name that are follows: lower-case, in order, each once. */
function layout(): { tags: string[][]; named: string[] } {
  const tags: string[][] = [];
  const named: string[] = [];
  for (let index = 0; index < FOLLOW_LIST_SIZE; index++) {
    const key = pubkeyAt(index);
    const other = OTHER_TAGS.get(index) ?? MALFORMED_TAGS.get(index);
    if (other !== undefined) {
      tags.push([...other]);
    } else if (index === DUPLICATE_AT) {
      tags.push(["p", DUPLICATED]);
      named.push(DUPLICATED);
    } else if (index === DUPLICATE_AGAIN_AT) {
      tags.push(["p", DUPLICATED, HINT, "met twice"]);
    } else if (index === UPPER_CASE_AT) {
      tags.push(["p", UPPER_CASED]);
      named.push(UPPER_CASE_KEY);
    } else {
      switch (index % 4) {
        case 0:
          tags.push(["p", key]);
          break;
        case 1:
          tags.push(["p", key, HINT]);
          break;
        case 2:
          tags.push(["p", key, HINT, `petname-${index}`]);
          break;
        default:
          tags.push(["p", key, "", `petname-${index}`]);
      }
      named.push(key);
    }
  }
  return { tags, named };
}

/** The keys the list names as follows: lower-case, in order, each once (`DUPLICATED` at its first place). Frozen: every test reads the same list. */
export const FOLLOWED_IN_LIST: readonly string[] = Object.freeze(layout().named);

/**
 * The list, signed by `secretKey` at `createdAt`: a kind 3 event of `FOLLOW_LIST_SIZE` tags and
 * `FOLLOW_LIST_CONTENT`. A fresh copy each time, so a test may change what it gets.
 */
export function buildFollowList(secretKey: Uint8Array, createdAt = FOLLOW_LIST_TIME): NostrEvent {
  return finalizeEvent(
    { kind: 3, created_at: createdAt, tags: layout().tags, content: FOLLOW_LIST_CONTENT },
    secretKey,
  );
}
