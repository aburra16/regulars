import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { parsePlace, type Place, PLACE_KIND } from "./place.ts";

/**
 * Reads stored events from a relay. The app's are made by `readerFor` (./relayReader.ts), and the
 * places relay's is `relayReader`; tests pass `createMemoryReader` (tests/support/memoryReader.ts),
 * so no test opens a socket.
 */
export interface RelayReader {
  /**
   * Yields the stored events that match `filter`, at most `filter.limit` of them, and ends
   * when the relay has sent them all. Throws if the read fails or `signal` aborts.
   */
  req(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent>;
}

/** The most events the places relay sends for one request (its `max_limit`). */
export const DEFAULT_PAGE_SIZE = 10_000;

/** A relay that keeps sending full pages of new places is stopped after this many. */
export const MAX_PAGES = 50;

/** The house's newest valid event at each address, and whatever it saw along the way. */
export interface HouseEvents {
  events: NostrEvent[];
  /** False when the list may hold more than these: the paging stopped before a short page. */
  complete: boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * The event in `value`, with exactly NIP-01's seven fields, or null if it does not have their
 * shape. The same check as Nostrify's `NSchema.event()` (tests/load.test.ts holds them to it),
 * written out so the first screen does not wait for zod: Nostrify loads with ./relayReader.ts.
 */
export function asEvent(value: unknown): NostrEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, pubkey, created_at, kind, tags, content, sig } = value as Record<string, unknown>;
  const ok =
    isText(id) &&
    HEX_64.test(id) &&
    isText(pubkey) &&
    HEX_64.test(pubkey) &&
    isText(sig) &&
    HEX_128.test(sig) &&
    Number.isSafeInteger(kind) &&
    (kind as number) >= 0 &&
    (kind as number) <= 65_535 &&
    Number.isSafeInteger(created_at) &&
    (created_at as number) >= 0 &&
    isText(content) &&
    Array.isArray(tags) &&
    tags.every((tag) => Array.isArray(tag) && tag.every(isText));
  return ok ? { id, pubkey, created_at, kind, tags, content, sig } as NostrEvent : null;
}

/** The request for one page of the house's places, newest first, from `until` back. */
function houseFilter(limit: number, until: number | undefined): NostrFilter {
  return {
    kinds: [PLACE_KIND],
    authors: [config.houseHex],
    "#z": [config.headerCoordinate],
    limit,
    ...(until === undefined ? {} : { until }),
  };
}

/** Prints a note for developers. Never shown to a person, and not in the production build. */
export function debug(message: string, ...details: unknown[]): void {
  if (import.meta.env.DEV) console.debug(`[places] ${message}`, ...details);
}

/** An event's address (`kind:pubkey:d`): what says two events are versions of one place. */
function addressOf(ev: NostrEvent): string {
  return `${ev.kind}:${ev.pubkey}:${ev.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`;
}

/** The newest event at each address of the house's list, from events that may be malformed. */
class Latest {
  readonly byAddress = new Map<string, NostrEvent>();
  /** Values that were not a well-formed event of the house account. */
  dropped = 0;
  /** The oldest `created_at` of the well-formed events seen, kept or not. */
  oldest: number | undefined;

  /**
   * Takes one value from a relay or from the device. Returns true when it is the first event
   * seen at its address.
   *
   * TODO(follow-up "Verify place signatures", Ruling R12): events are checked for shape and
   * author, not signature, so the places relay is trusted. Checking the signatures of 7,954
   * events took 6.7 s on a desktop (nostr-tools verifyEvent); measure on phones and move the
   * check off the main thread before adding it, here and in ./relayReader.ts.
   */
  add(value: unknown): boolean {
    const ev = asEvent(value);
    if (ev === null || ev.pubkey !== config.houseHex) {
      this.dropped += 1;
      return false;
    }
    this.oldest = this.oldest === undefined ? ev.created_at : Math.min(this.oldest, ev.created_at);

    const address = addressOf(ev);
    const kept = this.byAddress.get(address);
    if (kept === undefined || isNewer(ev, kept)) this.byAddress.set(address, ev);
    return kept === undefined;
  }

  get events(): NostrEvent[] {
    return [...this.byAddress.values()];
  }

  /** Notes the dropped values for developers, once per batch. */
  report(source: string): void {
    if (this.dropped > 0) debug(`dropped ${this.dropped} events from ${source}: malformed, or not the house's`);
  }
}

/** NIP-01's rule for two versions of one address: the later wins; at the same time, the lowest id. */
export function isNewer(a: Pick<NostrEvent, "id" | "created_at">, b: Pick<NostrEvent, "id" | "created_at">): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/**
 * Reads the house's list from the relay, page by page, newest first. A short page ends it. A
 * full page is followed by the next, `until` the oldest time seen, which includes that second
 * again, so nothing that shares it is missed. The importer signs a whole run at one time, so
 * if a page adds no new address the paging cannot get further: it stops there, incomplete.
 */
export async function fetchHouseEvents(
  reader: RelayReader,
  opts: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<HouseEvents> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const signal = opts.signal ?? new AbortController().signal;
  const latest = new Latest();
  let until: number | undefined;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    // An aborted load sends nothing (StrictMode's first mount, an unmount, a retry).
    signal.throwIfAborted();
    let received = 0;
    let added = 0;
    for await (const value of reader.req(houseFilter(pageSize, until), signal)) {
      received += 1;
      if (latest.add(value)) added += 1;
    }
    // A reader that stops quietly when aborted must not pass for a short, final page.
    signal.throwIfAborted();
    if (received < pageSize) {
      complete = true;
      break;
    }
    if (added === 0) break;
    until = latest.oldest;
  }

  latest.report("the relay");
  return { events: latest.events, complete };
}

/** The places among `events`, which `fetchHouseEvents` has already checked and deduplicated. */
export function parsePlaces(events: readonly NostrEvent[]): Place[] {
  return events.flatMap((ev) => parsePlace(ev, config.headerCoordinate) ?? []);
}

/**
 * The events in `values` saved on the device that the app reads: well-formed events of the house
 * account, the newest at each address. They are checked like the relay's.
 */
export function savedEvents(values: readonly unknown[]): NostrEvent[] {
  const latest = new Latest();
  for (const value of values) latest.add(value);
  latest.report("this device");
  return latest.events;
}

/** The places in `values` saved on the device: the places of the list among `savedEvents(values)`. */
export function placesFromEvents(values: readonly unknown[]): Place[] {
  return parsePlaces(savedEvents(values));
}

/** Each event's address, with the time of the version of it that `events` has. */
export type Stamps = ReadonlyMap<string, number>;

/** The addresses of `events` and the time of each, which say whether two copies of the list are the same. */
export function stampsOf(events: readonly NostrEvent[]): Stamps {
  return new Map(events.map((ev) => [addressOf(ev), ev.created_at]));
}

/** Whether `events` (one at each address) are the same versions of the same addresses as `stamps`. */
export function sameStamps(stamps: Stamps, events: readonly NostrEvent[]): boolean {
  return stamps.size === events.length && events.every((ev) => stamps.get(addressOf(ev)) === ev.created_at);
}

/** Reads the house's places from the relay. See `fetchHouseEvents` for the paging. */
export async function fetchHousePlaces(
  reader: RelayReader,
  opts: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<{ places: Place[]; complete: boolean }> {
  const { events, complete } = await fetchHouseEvents(reader, opts);
  return { places: parsePlaces(events), complete };
}
