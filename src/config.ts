import * as nip19 from "nostr-tools/nip19";

/** The Mise en Place account that publishes the places. Everything below derives from it. */
const houseNpub = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

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
};
