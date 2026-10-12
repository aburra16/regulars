import { config } from "../config.ts";
import type { RelayReader } from "../nostr/events.ts";
import { readerFor } from "../nostr/relayReader.ts";

/**
 * Reads from the places relay. This module and Nostrify, which it loads, are a chunk of their own:
 * src/places/store.tsx imports it when it first reads the relay, so saved places show before it comes.
 *
 * NRelay1 checks each signature by default, which took 6.7 s for the list on a desktop, on the main
 * thread. Off for the places relay: the store checks a sample of the list's signatures once it is in,
 * and every one when one of the sample fails (./signatures.ts). Every other relay's events are
 * checked (Ruling R3b).
 */
export const relayReader: RelayReader = readerFor(config.placesRelay, { verify: false });
