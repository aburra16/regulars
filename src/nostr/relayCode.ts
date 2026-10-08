import type { RelayReader, RelayWriter } from "./events.ts";

/*
 * The app's readers and writers of relays, which load the relay code (./relayReader.ts) when they are
 * first used: neither it nor Nostrify is in the first screen's code, and a session that reads no
 * review and posts none never loads it (tests/relay-chunk.test.ts).
 */

/** The load of the relay code, once started; forgotten if it fails, so a later read tries again. */
let relayCode: Promise<typeof import("./relayReader.ts")> | undefined;

/** Loads the relay code once, however many reads start at the same time. */
function loadRelayCode(): Promise<typeof import("./relayReader.ts")> {
  relayCode ??= import("./relayReader.ts").catch((error: unknown) => {
    relayCode = undefined;
    throw error;
  });
  return relayCode;
}

/** The app's reader of the relay at `url`, which checks each event's signature (`readerFor`). */
export const appReaders = (url: string): RelayReader => ({
  async *req(filter, signal) {
    signal.throwIfAborted();
    const { readerFor } = await loadRelayCode();
    yield* readerFor(url).req(filter, signal);
  },
});

/** The app's writer to the relay at `url` (`writerFor`). */
export const appWriters = (url: string): RelayWriter => ({
  async publish(event, signal) {
    signal.throwIfAborted();
    const { writerFor } = await loadRelayCode();
    signal.throwIfAborted();
    await writerFor(url).publish(event, signal);
  },
});
