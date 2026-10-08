import type { NostrEvent } from "@nostrify/nostrify";

/** The event kind of a place. */
export const PLACE_KIND = 39999;

export type AcceptsBitcoin = "lightning" | "onchain" | "both" | "yes";

export interface Place {
  /** The place's identity: `39999:<pubkey>:<d>`. Never an event id. */
  address: string;
  d: string;
  pubkey: string;
  name: string;
  category: string;
  /** The first cuisine only; every cuisine is in `keywords`, for search. */
  cuisine?: string;
  lat: number;
  lon: number;
  /** The 9-character geohash. */
  geohash: string;
  /** The `address` tag: a street address. */
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  /** Absent when the importer could not place the coordinates in a country. */
  country?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  description?: string;
  image?: string;
  acceptsBitcoin?: AcceptsBitcoin;
  osmId?: string;
  btcmapId?: string;
  /** The `t` tags. */
  keywords: string[];
  createdAt: number;
}

const PUBKEY = /^[0-9a-f]{64}$/;
const ACCEPTS_BITCOIN: ReadonlySet<string> = new Set<AcceptsBitcoin>(["lightning", "onchain", "both", "yes"]);

/** The value of the first tag called `name`. A tag with no text counts as absent, so a field is `undefined`, never "". */
function field(tags: readonly string[][], name: string): string | undefined {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** A coordinate within `limit` degrees of zero, or undefined for anything else. */
function coordinate(text: string | undefined, limit: number): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

/**
 * Reads a place from a relay event, or returns null when the event is not a well-formed
 * place of the list `headerCoordinate`. Events come from a relay and are untrusted, so a bad
 * value in any field gives null (or undefined for an optional field), not an exception.
 */
export function parsePlace(ev: NostrEvent, headerCoordinate: string): Place | null {
  if (ev.kind !== PLACE_KIND || !PUBKEY.test(ev.pubkey)) return null;
  const { tags } = ev;
  if (!tags.some((tag) => tag[0] === "z" && tag[1] === headerCoordinate)) return null;

  const d = field(tags, "d");
  const name = field(tags, "name");
  const category = field(tags, "category");
  const lat = coordinate(field(tags, "lat"), 90);
  const lon = coordinate(field(tags, "lon"), 180);
  const geohash = tags.find((tag) => tag[0] === "g" && tag[1]?.length === 9)?.[1];
  if (d === undefined || name === undefined || category === undefined) return null;
  if (lat === undefined || lon === undefined || geohash === undefined) return null;

  const acceptsBitcoin = field(tags, "accepts-bitcoin");

  return {
    address: `${PLACE_KIND}:${ev.pubkey}:${d}`,
    d,
    pubkey: ev.pubkey,
    name,
    category,
    cuisine: field(tags, "cuisine"),
    lat,
    lon,
    geohash,
    street: field(tags, "address"),
    locality: field(tags, "locality"),
    region: field(tags, "region"),
    postalCode: field(tags, "postal-code"),
    country: field(tags, "country"),
    phone: field(tags, "phone"),
    website: field(tags, "website"),
    openingHours: field(tags, "opening-hours"),
    description: field(tags, "description"),
    image: field(tags, "image"),
    acceptsBitcoin:
      acceptsBitcoin !== undefined && ACCEPTS_BITCOIN.has(acceptsBitcoin)
        ? (acceptsBitcoin as AcceptsBitcoin)
        : undefined,
    osmId: field(tags, "osm-id"),
    btcmapId: field(tags, "btcmap-id"),
    keywords: tags.flatMap((tag) => (tag[0] === "t" && tag[1] !== undefined && tag[1].trim() !== "" ? [tag[1]] : [])),
    createdAt: ev.created_at,
  };
}
