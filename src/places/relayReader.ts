import { type NostrRelayMsg, NRelay1 } from "@nostrify/nostrify";

import { config } from "../config.ts";
import type { RelayReader } from "./load.ts";

/** How long the relay has to answer at all: to connect, and send the first message of the request. */
export const CONNECT_TIMEOUT_MS = 20_000;

/** How long the relay may go quiet between one message and the next. Each message starts it again. */
export const IDLE_TIMEOUT_MS = 20_000;

/**
 * How long a request may take in all, however steadily the relay sends: the list is 8.5 MB, so a
 * slow link takes minutes, and a relay that never stops is still stopped.
 */
export const TOTAL_TIMEOUT_MS = 180_000;

/** NRelay1's `req` does not pass NOTICE messages on, so this one aborts a signal on any of them. */
class PlacesRelay extends NRelay1 {
  readonly notices = new AbortController();

  protected override receive(msg: NostrRelayMsg): void {
    if (msg[0] === "NOTICE") this.notices.abort(new Error(`The places relay sent a notice: ${msg[1]}`));
    super.receive(msg);
  }
}

/**
 * The three limits of one request, as a signal that aborts with a TimeoutError when any of them is
 * reached. `heard` says a message came, which starts the quiet time again; `stop` clears them all.
 */
function requestLimits(): { signal: AbortSignal; heard(): void; stop(): void } {
  const controller = new AbortController();
  const expire = (message: string) => () => controller.abort(new DOMException(message, "TimeoutError"));
  let quiet = setTimeout(expire("The places relay did not answer"), CONNECT_TIMEOUT_MS);
  const total = setTimeout(expire("The places relay took too long to send the list"), TOTAL_TIMEOUT_MS);
  return {
    signal: controller.signal,
    heard() {
      clearTimeout(quiet);
      quiet = setTimeout(expire("The places relay went quiet"), IDLE_TIMEOUT_MS);
    },
    stop() {
      clearTimeout(quiet);
      clearTimeout(total);
    },
  };
}

/**
 * Reads from the places relay, one connection per request, closed when the request ends. A
 * request ends well at EOSE; a CLOSED or NOTICE before it, or one of its limits, is an error.
 */
export const relayReader: RelayReader = {
  async *req(filter, signal) {
    signal.throwIfAborted();
    let relay: PlacesRelay | undefined;
    let stop: AbortSignal | undefined;
    const limits = requestLimits();
    try {
      relay = new PlacesRelay(config.placesRelay, {
        // TODO(follow-up "Verify place signatures", Ruling R12): NRelay1 checks each signature by
        // default, which took 6.7 s for the list on a desktop, on the main thread. Off until then.
        verifyEvent: () => true,
      });
      stop = AbortSignal.any([signal, limits.signal, relay.notices.signal]);
      for await (const msg of relay.req([filter], { signal: stop })) {
        limits.heard();
        if (msg[0] === "EVENT") yield msg[2];
        else if (msg[0] === "EOSE") return;
      }
      // NRelay1 ends the stream on CLOSED without passing it on.
      throw new Error("The places relay closed the request before the end of its stored events");
    } catch (error) {
      // NRelay1 ends an aborted request with a bare AbortError; pass on the reason instead.
      throw stop?.aborted ? stop.reason : error;
    } finally {
      limits.stop();
      void relay?.close().catch(() => {});
    }
  },
};
