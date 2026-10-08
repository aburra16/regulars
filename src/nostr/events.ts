import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { isHex64 } from "./shapes.ts";

/*
 * Events as the app reads them: the reader that brings them, the check on their shape, and the
 * order of two versions of one. Nothing here loads Nostrify at run time (its imports are types), so
 * the first screen can use it before the relay chunk (./relayReader.ts) arrives.
 */

/**
 * Reads stored events from a relay. The app's are made by `readerFor` (./relayReader.ts), and the
 * places relay's is `relayReader` (src/places/relayReader.ts); tests pass `createMemoryReader`
 * (tests/support/memoryReader.ts), so no test opens a socket.
 */
export interface RelayReader {
  /**
   * Yields the stored events that match `filter`, at most `filter.limit` of them, and ends
   * when the relay has sent them all. Throws if the read fails or `signal` aborts.
   */
  req(filter: NostrFilter, signal: AbortSignal): AsyncIterable<NostrEvent>;
}

/** Every value `reader` sends for `filter`, once it has sent them all. Throws as `req` does. */
export async function readAll(reader: RelayReader, filter: NostrFilter, signal: AbortSignal): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of reader.req(filter, signal)) values.push(value);
  return values;
}

/** What a read from one relay adds to its filter (`config.relayReadExtras`), such as a NIP-50 `search`. */
export type ReadExtras = Readonly<Pick<NostrFilter, "search">>;

/**
 * `reader`, adding `extras` to every filter it sends: what its relay is asked on top of what a read
 * asks for. Search words are put together, the relay's first ("include:spam bolo"), so that neither
 * replaces the other. With no extras it is `reader` itself.
 */
export function withReadExtras(reader: RelayReader, extras: ReadExtras | undefined): RelayReader {
  if (extras === undefined) return reader;
  return {
    req(filter, signal) {
      const search = [extras.search, filter.search].map((words) => words?.trim()).filter(Boolean).join(" ");
      return reader.req({ ...filter, ...extras, ...(search === "" ? {} : { search }) }, signal);
    },
  };
}

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
    isHex64(id) &&
    isText(pubkey) &&
    isHex64(pubkey) &&
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

/** NIP-01's rule for two versions of one address: the later wins; at the same time, the lowest id. */
export function isNewer(a: Pick<NostrEvent, "id" | "created_at">, b: Pick<NostrEvent, "id" | "created_at">): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}
