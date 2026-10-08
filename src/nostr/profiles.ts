import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { asEvent, isNewer, type RelayReader, readAll } from "./events.ts";
import { isHex64 } from "./shapes.ts";

/** The kind of a person's profile (NIP-01): its content is JSON, with their names in it (NIP-24). */
export const PROFILE_KIND = 0;

/**
 * Text that is a code standing for a person or a thing (NIP-19), which is never shown as a name: a
 * prefix, a 1, and at least 50 characters of bech32's alphabet (an npub has 58), so that a short
 * name that only begins like one, such as "Note12", is a name.
 */
const NIP19_CODE = /^(?:npub|nsec|nprofile|note|nevent|naddr|nrelay)1[02-9ac-hj-np-z]{50,}$/i;

/**
 * `value` as a name to show: text, with its format characters taken out (those that turn the text
 * around, or hide in it), its runs of space and control characters made one space, and none at
 * either end. Undefined when that leaves nothing, or a code or a key (64 hex digits): a name that
 * is a key would put the key on screen (Review Focus 4). Pages show names in a <bdi>, so that one
 * written right to left keeps to itself.
 */
function shownName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  if (text === "" || NIP19_CODE.test(text) || isHex64(text.toLowerCase())) return undefined;
  return text;
}

/**
 * The name a profile's `content` gives: its `display_name`, else its `name` (NIP-24), each taken
 * only if it can be shown. Undefined when the content is not a JSON object, or neither name can.
 */
export function nameIn(content: string): string | undefined {
  let profile: unknown;
  try {
    profile = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined;
  const fields = profile as Record<string, unknown>;
  return shownName(fields.display_name) ?? shownName(fields.name);
}

/**
 * Each person's name among `values`, from their newest profile: a newer profile with no name
 * replaces an older one with a name, as the person meant. Someone with no name is not in the map.
 * `values` must come from a reader that checks signatures (`readerFor` does): anyone can write a
 * profile event naming anyone.
 */
export function namesFrom(values: readonly unknown[]): Map<string, string> {
  const newest = new Map<string, NostrEvent>();
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== PROFILE_KIND) continue;
    const kept = newest.get(ev.pubkey);
    if (kept === undefined || isNewer(ev, kept)) newest.set(ev.pubkey, ev);
  }

  const names = new Map<string, string>();
  for (const [pubkey, ev] of newest) {
    const name = nameIn(ev.content);
    if (name !== undefined) names.set(pubkey, name);
  }
  return names;
}

/**
 * The names of `pubkeys`, from their profiles on each of `relays`, read side by side. Null when no
 * relay answered: the names are unknown, which is not the same as having none. Throws only when
 * `signal` aborts.
 */
export async function fetchNames(
  readers: (url: string) => RelayReader,
  relays: readonly string[],
  pubkeys: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string> | null> {
  // A profile is replaceable: a relay keeps one per person, so one each is all there is to ask for.
  const filter: NostrFilter = { kinds: [PROFILE_KIND], authors: [...pubkeys], limit: pubkeys.length };
  // A reader that cannot be made fails its relay's read, as a read that fails does.
  const reads = await Promise.allSettled(relays.map(async (url) => readAll(readers(url), filter, signal)));
  signal.throwIfAborted();
  const answered = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
  return answered.length === 0 ? null : namesFrom(answered.flat());
}
