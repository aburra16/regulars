import * as nip19 from "nostr-tools/nip19";

import { isHex64, isRelayUrl } from "./nostr/shapes.ts";

/** The Mise en Place account that publishes the places. Everything below derives from it. */
const houseNpub = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

/** Brainstorm's search relay (NIP-50), which keeps the reviews (docs/decisions.md #16). */
const searchRelay = "wss://search.brainstorm.world";

/**
 * Two big public relays that keep the reviews too (docs/decisions.md #29), so that posting and reading
 * do not hang on one relay: a review is posted once any review relay takes it.
 */
const publicReviewRelays = ["wss://nos.lol", "wss://relay.primal.net"];

function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected an npub, got ${decoded.type}`);
  return decoded.data;
}

/**
 * CI passes VITE_MAPTILER_KEY as an empty string when the repository secret is absent,
 * so an empty or blank value means "no key", the same as unset.
 */
function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The relays in `text`, a comma-separated list, leaving out anything that is not a ws: or wss: URL. */
function relayList(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(isRelayUrl);
}

/** A scorer written `<public key in hex>@<relay>`; undefined when unset, or written any other way. */
function scorerOverride(text: string | undefined): Config["devScorer"] {
  const value = optionalEnv(text);
  const at = value?.indexOf("@") ?? -1;
  if (value === undefined || at < 0) return undefined;
  const pubkey = value.slice(0, at);
  const relay = value.slice(at + 1);
  return isHex64(pubkey) && isRelayUrl(relay) ? { pubkey, relay } : undefined;
}

interface Config {
  appName: "Regulars";
  domain: "askregulars.world";
  /** The house account that publishes the places, and its public key in hex. */
  houseNpub: string;
  houseHex: string;
  headerCoordinate: string;
  placesRelay: string;
  /**
   * Where the places are near when nothing else says: no town picked, the device's location not
   * already allowed, the device's time zone not a known place, and no town in its language's country
   * (docs/decisions.md #24; src/location/guess.ts). `radiusKm` is how far "near" reaches, wherever that is.
   */
  defaultCity: { name: "Funchal"; lat: number; lon: number; radiusKm: number };
  /** From VITE_MAPTILER_KEY; undefined when unset, so there is no map. */
  mapTilerKey: string | undefined;
  /**
   * What is open. `signIn`: signing in, with a browser add-on or an app on a phone (docs/decisions.md
   * #21). `circle`: My circle, the person's own scores, which needs their circle worked out: a person
   * signed in can Personalize, which asks Brainstorm, and the toggle's My circle half turns on once
   * their circle is ready (src/circle/CircleProvider.tsx), its scores worked out from their circle's
   * ranks (src/score/store.ts; the M3 plan, Task 3). Closed, nothing asks Brainstorm, and the half
   * reads "soon" for a person who has signed in.
   * `saved`: Saved in the phone's tabs and the desktop's top bar; it comes back with saved lists
   * (brief § 13, step 7). Until then a link to /saved still opens its page, which says saving opens soon.
   */
  features: { signIn: boolean; circle: boolean; saved: boolean };
  /**
   * Where the app meets an app on a phone that signs for the person (NIP-46): the one relay it shows
   * in its nostrconnect link, and reaches only to connect and to ask that app to sign.
   */
  connectRelay: string;
  /**
   * Where reviews (kind 34259) are posted to and read from. In production, Brainstorm's search relay
   * (docs/decisions.md #16) and two public relays (#29); in development, VITE_REVIEW_RELAYS, and none
   * when it is unset.
   */
  reviewRelays: string[];
  /**
   * What a read from a relay adds to its filter, by the relay's URL. The search relay leaves out what
   * it takes for spam unless asked with `search: "include:spam"`; the app draws its own line
   * (docs/decisions.md #16). Only that relay is asked so: another NIP-50 relay would take the words
   * as a search.
   */
  relayReadExtras: Record<string, { search?: string }>;
  /**
   * Where a person's relay list (kind 10002, NIP-65) is looked for, beside the review relays, when a
   * review is posted: relays that keep people's lists and little else. A review goes to the relays it names.
   */
  relayListRelays: string[];
  /** Where the house's kind 10040 is read, which names the scorer whose ranks are House picks. */
  houseTrustRelays: string[];
  /**
   * Brainstorm's API, which works out a person's circle (My circle; src/circle/brainstorm.ts). Once a
   * signed-in session, after the places load, the app asks it one unauthenticated `GET /setup/{pubkey}`,
   * which reads a public setup and creates nothing, to find a circle worked out before (ruling R5).
   * Every other request (its sign-in, which sets up the person's public scoring profile, and the
   * person's runs) comes only after a tap: Personalize, Try again, Work out my circle again, Update now.
   */
  brainstormApi: string;
  /**
   * `line`: the lowest rank that counts, out of 100 (docs/decisions.md #18). A list is ordered as
   * if each place also had `priorWeight` of a vote of `priorMean` stars, so one five-star review
   * does not top it (brief § 5). Tunable.
   */
  scoring: { line: number; priorWeight: number; priorMean: number };
  /**
   * Development only, from VITE_DEV_SCORER: an account that publishes trust ranks (kind 30382), and
   * its relay, to use in place of the scorer the house names.
   */
  devScorer?: { pubkey: string; relay: string };
}

/** Everything configurable lives here. Nothing else hardcodes these values. */
export const config: Config = {
  appName: "Regulars",
  domain: "askregulars.world",
  houseNpub,
  houseHex: npubToHex(houseNpub),
  headerCoordinate:
    "39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places",
  placesRelay: "wss://dcosl.brainstorm.world",
  defaultCity: { name: "Funchal", lat: 32.6507, lon: -16.9084, radiusKm: 25 },
  mapTilerKey: optionalEnv(import.meta.env.VITE_MAPTILER_KEY),
  features: { signIn: true, circle: true, saved: false },
  connectRelay: "wss://relay.nsec.app",
  // In a production build `import.meta.env.DEV` is false, so neither variable is read there.
  reviewRelays: import.meta.env.DEV ? relayList(import.meta.env.VITE_REVIEW_RELAYS) : [searchRelay, ...publicReviewRelays],
  relayReadExtras: { [searchRelay]: { search: "include:spam" } },
  relayListRelays: ["wss://purplepag.es"],
  houseTrustRelays: ["wss://scores.brainstorm.world"],
  brainstormApi: "https://api.brainstorm.world",
  scoring: { line: 5, priorWeight: 1.5, priorMean: 3.5 },
  devScorer: import.meta.env.DEV ? scorerOverride(import.meta.env.VITE_DEV_SCORER) : undefined,
};
