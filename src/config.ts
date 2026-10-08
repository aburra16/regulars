import * as nip19 from "nostr-tools/nip19";

import { isHex64, isRelayUrl } from "./nostr/shapes.ts";

/** The Mise en Place account that publishes the places. Everything below derives from it. */
const houseNpub = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

/** Brainstorm's search relay (NIP-50), which keeps the reviews (docs/decisions.md #16). */
const searchRelay = "wss://search.brainstorm.world";

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
  defaultCity: { name: "Funchal"; lat: number; lon: number; radiusKm: number };
  /** From VITE_MAPTILER_KEY; undefined when unset, so there is no map. */
  mapTilerKey: string | undefined;
  features: { signIn: boolean };
  /**
   * Where reviews (kind 34259) are read from. In production, Brainstorm's search relay
   * (docs/decisions.md #16); in development, VITE_REVIEW_RELAYS, and none when it is unset.
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
  features: { signIn: false },
  // In a production build `import.meta.env.DEV` is false, so neither variable is read there.
  reviewRelays: import.meta.env.DEV ? relayList(import.meta.env.VITE_REVIEW_RELAYS) : [searchRelay],
  relayReadExtras: { [searchRelay]: { search: "include:spam" } },
  relayListRelays: ["wss://purplepag.es"],
  houseTrustRelays: ["wss://scores.brainstorm.world"],
  scoring: { line: 5, priorWeight: 1.5, priorMean: 3.5 },
  devScorer: import.meta.env.DEV ? scorerOverride(import.meta.env.VITE_DEV_SCORER) : undefined,
};
