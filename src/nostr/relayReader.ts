// First: zod is told, before Nostrify uses it, not to try eval (./zod.ts).
import "./zod.ts";

import { type NostrRelayMsg, NRelay1, type NRelay1Opts } from "@nostrify/nostrify";

import type { RelayReader, RelayWriter } from "./events.ts";

/*
 * Reading a relay over its socket, and sending it a review. This loads Nostrify and what it brings (zod, websocket-ts,
 * nostr-tools), so the first screen's code reaches it only through a dynamic import() (as
 * src/places/store.tsx and ./relayCode.ts do, Ruling R2): it stays a chunk of its own, out of the entry.
 */

/** How long the relay has to answer at all: to connect, and send the first message of the request. */
export const CONNECT_TIMEOUT_MS = 20_000;

/** How long the relay may go quiet between one message and the next. Each message starts it again. */
export const IDLE_TIMEOUT_MS = 20_000;

/**
 * How long a request may take in all, however steadily the relay sends: the list is 8.5 MB, so a
 * slow link takes minutes, and a relay that never stops is still stopped.
 */
export const TOTAL_TIMEOUT_MS = 180_000;

/**
 * NRelay1's `req` does not pass NOTICE messages on, so this one aborts a signal on any of them. It
 * notes, too, whether the relay has said anything of a request, which NRelay1 does not tell of an
 * event it drops (one whose signature fails, or that no filter asked for).
 */
class NoticeRelay extends NRelay1 {
  readonly notices = new AbortController();
  /** Whether the relay has sent anything about a request yet: an EVENT, an EOSE, a CLOSED or a NOTICE. */
  spoke = false;
  /** NRelay1 keeps its URL private; this copy names the relay in the notice's error. */
  private readonly relayUrl: string;

  constructor(url: string, opts: NRelay1Opts) {
    super(url, opts);
    this.relayUrl = url;
  }

  protected override receive(msg: NostrRelayMsg): void {
    if (msg[0] === "EVENT" || msg[0] === "EOSE" || msg[0] === "CLOSED" || msg[0] === "NOTICE") this.spoke = true;
    if (msg[0] === "NOTICE") this.notices.abort(new Error(`${this.relayUrl} sent a notice: ${msg[1]}`));
    super.receive(msg);
  }
}

/**
 * The three limits of one request to `url`, as a signal that aborts with a TimeoutError when any of
 * them is reached. `heard` says a message came, which starts the quiet time again; `stop` clears them all.
 */
function requestLimits(url: string): { signal: AbortSignal; heard(): void; stop(): void } {
  const controller = new AbortController();
  const expire = (message: string) => () => controller.abort(new DOMException(message, "TimeoutError"));
  let quiet = setTimeout(expire(`${url} did not answer`), CONNECT_TIMEOUT_MS);
  const total = setTimeout(expire(`${url} took too long to send its events`), TOTAL_TIMEOUT_MS);
  return {
    signal: controller.signal,
    heard() {
      clearTimeout(quiet);
      quiet = setTimeout(expire(`${url} went quiet`), IDLE_TIMEOUT_MS);
    },
    stop() {
      clearTimeout(quiet);
      clearTimeout(total);
    },
  };
}

/**
 * Reads from the relay at `url`, one connection per request, closed when the request ends. A
 * request ends well at EOSE; a CLOSED or NOTICE before it, or one of its limits, is an error.
 * NRelay1 checks each event's signature and drops any that fails, unless `verify` is false.
 *
 * A connection that is refused, fails or closes is made again by NRelay1 itself, and the request
 * sent on it: a read waits for that, under its limits. A read that asks not to (`failFast`, ruling
 * R40) ends instead, with a `NetworkError` as the writer's, the moment the connection is lost before
 * the relay has said anything on it; once the relay has, that read goes on under the limits as any
 * other. It is safe for the reads that ask for it because each of them takes a relay that did not
 * answer for just that, whatever the reason, and errs on the safe side of it: fewer relays answered,
 * never a list that was guessed, and the answers a new account needs are harder to have, not easier.
 * Without it nothing of a read is other than it was: nothing is listened for, and no error is new.
 */
export function readerFor(url: string, { verify = true }: { verify?: boolean } = {}): RelayReader {
  return {
    async *req(filter, signal, { failFast = false } = {}) {
      signal.throwIfAborted();
      let relay: NoticeRelay | undefined;
      let stop: AbortSignal | undefined;
      const limits = requestLimits(url);
      // Only for a read that asked not to wait: aborts when the connection is lost before the relay has spoken.
      const lost = failFast ? new AbortController() : undefined;
      const onLost = () => {
        if (relay?.spoke === false) lost?.abort(new DOMException(`${url} lost its connection before it answered`, "NetworkError"));
      };
      let socket: EventTarget | undefined;
      try {
        relay = new NoticeRelay(url, verify ? {} : { verifyEvent: () => true });
        if (lost !== undefined) {
          // The browser's socket under NRelay1's, as the writer finds it (`writerFor`): it says when the
          // first connection is lost. Should an upgrade move it, the read waits out its limits, as it
          // did before (tests/relayReaderSocket.test.ts fails then, to say so).
          socket = relay.socket?.underlyingWebsocket;
          socket?.addEventListener("close", onLost);
          socket?.addEventListener("error", onLost);
        }
        stop = AbortSignal.any([signal, limits.signal, relay.notices.signal, ...(lost === undefined ? [] : [lost.signal])]);
        for await (const msg of relay.req([filter], { signal: stop })) {
          limits.heard();
          if (msg[0] === "EVENT") yield msg[2];
          else if (msg[0] === "EOSE") return;
        }
        // NRelay1 ends the stream on CLOSED without passing it on.
        throw new Error(`${url} closed the request before the end of its stored events`);
      } catch (error) {
        // NRelay1 ends an aborted request with a bare AbortError; pass on the reason instead.
        throw stop?.aborted ? stop.reason : error;
      } finally {
        limits.stop();
        socket?.removeEventListener("close", onLost);
        socket?.removeEventListener("error", onLost);
        void relay?.close().catch(() => {});
      }
    },
  };
}

/**
 * Sends events to the relay at `url`, one connection for each, closed once the relay has answered:
 * done when it takes the event (`OK` true, a `duplicate:` one too), an error with its reason when it
 * refuses it, and a `NetworkError` when the connection closes or fails before it has answered. NRelay1
 * would wait on then: it does not send the event again, and the relay may never have read it. A relay
 * that never answers is waited on until `signal` aborts, which the caller bounds (src/review/post.ts).
 * The connection is closed once it ends, and nothing of it is left listening.
 */
export function writerFor(url: string): RelayWriter {
  return {
    async publish(event, signal) {
      signal.throwIfAborted();
      let relay: NRelay1 | undefined;
      const lost = new AbortController();
      // The relay is named where this is logged (src/review/post.ts), so it is not named here too.
      const onLost = () => lost.abort(new DOMException("The connection was lost before the relay answered", "NetworkError"));
      let socket: EventTarget | undefined;
      try {
        relay = new NRelay1(url);
        // NRelay1's socket is websocket-ts's, over the browser's; for a lone event it opens no other,
        // so the browser's says when the connection is lost. Should an upgrade move it, the try is
        // waited out, as it was before (tests/relayWriter.test.ts fails then, to say so).
        socket = relay.socket?.underlyingWebsocket;
        socket?.addEventListener("close", onLost);
        socket?.addEventListener("error", onLost);
        await relay.event(event, { signal: AbortSignal.any([signal, lost.signal]) });
      } catch (error) {
        // NRelay1 ends an aborted send with a bare AbortError; pass on the reason instead.
        throw signal.aborted ? signal.reason : lost.signal.aborted ? lost.signal.reason : error;
      } finally {
        socket?.removeEventListener("close", onLost);
        socket?.removeEventListener("error", onLost);
        void relay?.close().catch(() => {});
      }
    },
  };
}
