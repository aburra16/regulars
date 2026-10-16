import * as nip19 from "nostr-tools/nip19";

import { isHex64, isRelayUrl } from "./nostr/shapes.ts";

/** The Mise en Place account that publishes the places. Everything below derives from it. */
const houseNpub = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

/** Brainstorm's search relay (NIP-50), which keeps the reviews (decision 16). */
const searchRelay = "wss://search.brainstorm.world";

/**
 * Two big public relays that keep the reviews too (decision 29), so that posting and reading
 * do not hang on one relay: a review is posted once any review relay takes it.
 */
const publicReviewRelays = ["wss://nos.lol", "wss://relay.primal.net"];

/**
 * The list hub: the relay the places are read from (`placesRelay`), and the hint a review gives with
 * its place's address (src/reviews/write.ts).
 */
const hubRelay = "wss://dcosl.brainstorm.world";

/**
 * Where a person's follow list is read and saved in production, beside their own relays: Purplepages
 * and five public relays. Six, as a first list is made for a new account only when more than half of
 * them answer, and one or two are often out of reach (rulings R14 and R16).
 */
const publicFollowListRelays = [
  "wss://purplepag.es",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nostr.mom",
  "wss://nostr.oxtr.dev",
];

function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected an npub, got ${decoded.type}`);
  return decoded.data;
}

/** A setting from the environment: an empty or blank value is the same as unset. */
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
   * How many of the places' signatures are checked when a fresh list comes from the places relay,
   * picked at random; every one is checked when one of them fails, and each that fails is left out
   * (src/places/signatures.ts). The relay is read with its own checks off: all 7,954 took 6.7 s on a
   * desktop.
   */
  placesSignatureSample: number;
  /**
   * Where the places are near when nothing else says: no town picked, the device's location not
   * already allowed, the device's time zone not a known place, and no town in its language's country
   * (decision 24; src/location/guess.ts). `radiusKm` is how far "near" reaches, wherever that is.
   */
  defaultCity: { name: "Funchal"; lat: number; lon: number; radiusKm: number };
  /**
   * Whether maps draw OpenFreeMap's tiles (src/map/style.ts), which need no key. Off, a map is the
   * plain ground in the land colour, with the pins on it and nothing fetched: as the tests draw it.
   */
  mapTiles: boolean;
  /**
   * What is open. `signIn`: signing in, with a browser add-on or an app on a phone (decision 21).
   * `circle`: My circle, the person's own scores, which needs their circle worked out: a person
   * signed in can Personalize, which asks Brainstorm, and the toggle's My circle half turns on once
   * their circle is ready (src/circle/CircleProvider.tsx), its scores worked out from their circle's
   * ranks (src/score/store.ts; the M3 plan, Task 3). Closed, nothing asks Brainstorm, and the half
   * reads "soon" for a person who has signed in.
   * `saved`: Saved in the phone's tabs and the desktop's top bar; it comes back with saved lists
   * (brief § 13, step 7). Until then a link to /saved still opens its page, which says saving opens soon.
   * `follow`: the Follow button, and with it every read and every change of a follow list (ruling
   * R39). It is on for everyone, in every build. It is the off switch too: set to `false` here and
   * deployed, Follow is hidden for everyone again. Off, there is no Follow button and no line of who
   * follows a person, nobody's follow list is read or changed, and a phone app is not asked to sign
   * one.
   */
  features: { signIn: boolean; circle: boolean; saved: boolean; follow: boolean };
  /**
   * Where the app meets an app on a phone that signs for the person (NIP-46): the one relay it shows
   * in its nostrconnect link, and reaches only to connect and to ask that app to sign.
   */
  connectRelay: string;
  /**
   * Where reviews (kind 34259) are posted to, and where a post counts as made; where reviews, and the
   * removals of them (kind 5), are read, by the places' pages and lists, a person's page and Recent.
   * In production, Brainstorm's search relay (decision 16) and two public relays (decision 29); in
   * development, VITE_REVIEW_RELAYS, and none when it is unset. Names and pictures are read here too.
   */
  reviewRelays: string[];
  /**
   * What a read from a relay adds to its filter, by the relay's URL. The search relay leaves out what
   * it takes for spam unless asked with `search: "include:spam"`; the app draws its own line
   * (decision 16). Only that relay is asked so: another NIP-50 relay would take the words
   * as a search.
   */
  relayReadExtras: Record<string, { search?: string }>;
  /**
   * Where a person's relay list (kind 10002, NIP-65) is looked for, beside the review relays, when a
   * review is posted: relays that keep people's lists and little else. A review goes to the relays it names.
   */
  relayListRelays: string[];
  /**
   * Where a person's follow list (kind 3, NIP-02) is read and saved, beside the relays their own relay
   * list names. In production, Purplepages and five public relays (`publicFollowListRelays`), so that a
   * list is found wherever other apps left it and a changed one is kept in more than one place. In development,
   * VITE_FOLLOW_LIST_RELAYS, and none when it is unset: none of the app's own is a public relay in
   * development (ruling R17). The person's own relays are another matter: signed in with a real key,
   * a development build reads that key's relay list (`relayListRelays`) and saves a tapped follow to
   * the public relays it names, so development is for throwaway keys. The review relays are not
   * among them as such: the search relay keeps no follow lists, and answers as if a person had none.
   * The two public review relays are named among the six, and so are.
   */
  followListRelays: string[];
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
   * Brainstorm's own site, which "Built on Brainstorm" at the foot of every page links to
   * (src/ui/BuiltOnBrainstorm.tsx). A page the person opens in a new tab: the app never fetches it.
   */
  brainstormSite: string;
  /**
   * `line`: the lowest rank that counts, out of 100 (decision 18). A list is ordered as
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
  placesRelay: hubRelay,
  placesSignatureSample: 64,
  defaultCity: { name: "Funchal", lat: 32.6507, lon: -16.9084, radiusKm: 25 },
  mapTiles: true,
  features: { signIn: true, circle: true, saved: false, follow: true },
  connectRelay: "wss://relay.nsec.app",
  // In a production build `import.meta.env.DEV` is false, so none of these variables is read there.
  reviewRelays: import.meta.env.DEV ? relayList(import.meta.env.VITE_REVIEW_RELAYS) : [searchRelay, ...publicReviewRelays],
  relayReadExtras: { [searchRelay]: { search: "include:spam" } },
  relayListRelays: ["wss://purplepag.es"],
  followListRelays: import.meta.env.DEV ? relayList(import.meta.env.VITE_FOLLOW_LIST_RELAYS) : [...publicFollowListRelays],
  houseTrustRelays: ["wss://scores.brainstorm.world"],
  brainstormApi: "https://api.brainstorm.world",
  brainstormSite: "https://brainstorm.world",
  scoring: { line: 5, priorWeight: 1.5, priorMean: 3.5 },
  devScorer: import.meta.env.DEV ? scorerOverride(import.meta.env.VITE_DEV_SCORER) : undefined,
};
