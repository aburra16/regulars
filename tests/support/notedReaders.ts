import type { NostrFilter } from "@nostrify/nostrify";

import type { Readers, ReadOptions } from "../../src/nostr/events.ts";

/*
 * Readers that note what they are asked, for the tests that count what every relay of a page was
 * asked (tests/followOff.test.tsx) and how each read was to be made (tests/failFast.test.tsx). They
 * pass everything on as it came, and change nothing.
 */

/** A request a reader was sent: the relay it went to, what it asked, and how it was to be read, as the caller gave it. */
export interface Noted {
  url: string;
  filter: NostrFilter;
  opts: ReadOptions | undefined;
}

/** `readers`, with every request any of them is sent noted, in order. */
export function noted(readers: Readers) {
  const asked: Noted[] = [];
  const noting: Readers = (url) => {
    const reader = readers(url);
    return {
      req(filter, signal, opts) {
        asked.push({ url, filter, opts });
        return reader.req(filter, signal, opts);
      },
    };
  };
  /** The requests that asked for events of `kind`, whoever they were by and whoever they named. */
  const ofKind = (kind: number) => asked.filter(({ filter }) => filter.kinds?.includes(kind) === true);
  return { readers: noting, asked, ofKind };
}
