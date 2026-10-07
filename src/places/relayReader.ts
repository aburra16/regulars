import { type NostrRelayMsg, NRelay1 } from "@nostrify/nostrify";

import { config } from "../config.ts";
import type { RelayReader } from "./load.ts";

/** A request gets this long in all, from connecting to the last stored event. */
const TIMEOUT_MS = 20_000;

/** NRelay1's `req` does not pass NOTICE messages on, so this one aborts a signal on any of them. */
class PlacesRelay extends NRelay1 {
  readonly notices = new AbortController();

  protected override receive(msg: NostrRelayMsg): void {
    if (msg[0] === "NOTICE") this.notices.abort(new Error(`The places relay sent a notice: ${msg[1]}`));
    super.receive(msg);
  }
}

/**
 * Reads from the places relay, one connection per request, closed when the request ends. A
 * request ends well at EOSE; a CLOSED or NOTICE before it, or the timeout, is an error.
 */
export const relayReader: RelayReader = {
  async *req(filter, signal) {
    signal.throwIfAborted();
    let relay: PlacesRelay | undefined;
    let stop: AbortSignal | undefined;
    try {
      relay = new PlacesRelay(config.placesRelay, {
        // TODO(follow-up "Verify place signatures", Ruling R12): NRelay1 checks each signature by
        // default, which took 6.7 s for the list on a desktop, on the main thread. Off until then.
        verifyEvent: () => true,
      });
      stop = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS), relay.notices.signal]);
      for await (const msg of relay.req([filter], { signal: stop })) {
        if (msg[0] === "EVENT") yield msg[2];
        else if (msg[0] === "EOSE") return;
      }
      // NRelay1 ends the stream on CLOSED without passing it on.
      throw new Error("The places relay closed the request before the end of its stored events");
    } catch (error) {
      // NRelay1 ends an aborted request with a bare AbortError; pass on the reason instead.
      throw stop?.aborted ? stop.reason : error;
    } finally {
      void relay?.close().catch(() => {});
    }
  },
};
