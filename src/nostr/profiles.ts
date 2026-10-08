import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { asEvent, isNewer, type RelayReader, readAll } from "./events.ts";
import { isHex64 } from "./shapes.ts";

/** The kind of a person's profile (NIP-01): its content is JSON, with their names (NIP-24) and picture in it. */
export const PROFILE_KIND = 0;

/**
 * Text that is a code standing for a person or a thing (NIP-19), which is never shown as a name: a
 * prefix, a 1, and at least 50 characters of bech32's alphabet (an npub has 58), so that a short
 * name that only begins like one, such as "Note12", is a name.
 */
const NIP19_CODE = /^(?:npub|nsec|nprofile|note|nevent|naddr|nrelay)1[02-9ac-hj-np-z]{50,}$/i;

/**
 * The characters that can reorder the text around them: the bidirectional embeddings and overrides
 * (U+202A to U+202E), isolates (U+2066 to U+2069) and marks (U+200E, U+200F, U+061C). A name loses
 * them. Other format characters stay: names are written with them, such as the joiner inside an
 * emoji (U+200D) or the non-joiner of Persian (U+200C).
 */
const REORDERING = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu;

/**
 * Characters that show nothing: space, the format characters, the other code points that a font draws
 * as nothing (Unicode's default ignorables: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the
 * combining grapheme joiner, variation selectors ...), and the blank Braille pattern U+2800, which is
 * a symbol with no dots.
 */
const INVISIBLE = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/**
 * `value` as a name to show: text, with the characters that reorder text taken out, its runs of
 * space and control characters made one space, and none at either end. Undefined when nothing in
 * it shows, or what shows is a code or a key (64 hex digits), whatever invisible characters are
 * among it: a name that is a key would put the key on screen (Review Focus 4). Pages show names in a <bdi>, which keeps one written right to left, and
 * any format characters left in it, to itself.
 */
function shownName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(REORDERING, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  // A code or a key with invisible characters in it still shows as the code: it is looked for without them.
  const shown = text.replace(INVISIBLE, "");
  if (shown === "" || NIP19_CODE.test(shown) || isHex64(shown.toLowerCase())) return undefined;
  return text;
}

/** The longest picture address taken, in characters: anything longer is no picture. */
const PICTURE_MAX_LENGTH = 2000;

/**
 * `value` as a picture's address to load: an absolute https address, with no user name or password
 * in it, of at most `PICTURE_MAX_LENGTH` characters once trimmed. Undefined otherwise: no other
 * scheme (http, data, javascript ...), and nothing relative.
 */
function shownPicture(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > PICTURE_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    // With no base, so a relative address throws. (`URL.canParse` is not in Safari before 17.)
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  // As the browser will ask for it, which may be longer once escaped.
  return url.href.length > PICTURE_MAX_LENGTH ? undefined : url.href;
}

/** The fields of a profile's `content`; undefined when it is not a JSON object. */
function fieldsIn(content: string): Record<string, unknown> | undefined {
  let profile: unknown;
  try {
    profile = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined;
  return profile as Record<string, unknown>;
}

/** The name in a profile's fields: its `display_name`, else its `name` (NIP-24), each taken only if it can be shown. */
const nameOf = (fields: Record<string, unknown>) => shownName(fields.display_name) ?? shownName(fields.name);

/**
 * The name a profile's `content` gives: its `display_name`, else its `name` (NIP-24), each taken
 * only if it can be shown. Undefined when the content is not a JSON object, or neither name can.
 */
export function nameIn(content: string): string | undefined {
  const fields = fieldsIn(content);
  return fields === undefined ? undefined : nameOf(fields);
}

/**
 * The picture a profile's `content` gives (its `picture`, NIP-01), if it may be loaded
 * (`shownPicture`). Undefined when the content is not a JSON object, or it gives none that may.
 */
export function pictureIn(content: string): string | undefined {
  return shownPicture(fieldsIn(content)?.picture);
}

/** What a person's profile gives: a name to show, and a picture that may be loaded; each only if it does. */
export interface Profile {
  name?: string;
  picture?: string;
}

/**
 * Each person's profile among `values`, from their newest: a newer profile with no name, or no
 * picture, replaces an older one with one, as the person meant. Someone whose profile gives
 * neither is not in the map. `values` must come from a reader that checks signatures (`readerFor`
 * does): anyone can write a profile event naming anyone.
 */
export function profilesFrom(values: readonly unknown[]): Map<string, Profile> {
  const newest = new Map<string, NostrEvent>();
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== PROFILE_KIND) continue;
    const kept = newest.get(ev.pubkey);
    if (kept === undefined || isNewer(ev, kept)) newest.set(ev.pubkey, ev);
  }

  const profiles = new Map<string, Profile>();
  for (const [pubkey, ev] of newest) {
    const fields = fieldsIn(ev.content);
    if (fields === undefined) continue;
    const name = nameOf(fields);
    const picture = shownPicture(fields.picture);
    if (name === undefined && picture === undefined) continue;
    profiles.set(pubkey, { ...(name === undefined ? {} : { name }), ...(picture === undefined ? {} : { picture }) });
  }
  return profiles;
}

/**
 * The profiles of `pubkeys` (`profilesFrom`), from each of `relays`, read side by side. Null when no
 * relay answered: the profiles are unknown, which is not the same as having none. Throws only when
 * `signal` aborts.
 */
export async function fetchProfiles(
  readers: (url: string) => RelayReader,
  relays: readonly string[],
  pubkeys: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, Profile> | null> {
  // A profile is replaceable: a relay keeps one per person, so one each is all there is to ask for.
  const filter: NostrFilter = { kinds: [PROFILE_KIND], authors: [...pubkeys], limit: pubkeys.length };
  // A reader that cannot be made fails its relay's read, as a read that fails does.
  const reads = await Promise.allSettled(relays.map(async (url) => readAll(readers(url), filter, signal)));
  signal.throwIfAborted();
  const answered = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
  return answered.length === 0 ? null : profilesFrom(answered.flat());
}
