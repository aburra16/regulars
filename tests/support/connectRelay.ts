import {
  type NostrEvent,
  type NostrFilter,
  type NostrRelayCLOSED,
  type NostrRelayEOSE,
  type NostrRelayEVENT,
  type NRelay,
  NSecSigner,
} from "@nostrify/nostrify";
import { matchFilters } from "nostr-tools/filter";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

/*
 * A stand-in for the NIP-46 meeting point (wss://relay.nsec.app) and for a signer app on a phone,
 * for tests: no socket is opened. The relay passes on what is published to the subscriptions open at
 * that moment, as a relay does with kind 24133, which it does not keep. The signer app holds a
 * person's key and answers the app's requests over the relay, encrypted with NIP-44, as a real one does.
 */

type Message = NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED;

/** The kind of a NIP-46 request or response. */
const CONNECT_KIND = 24133;

interface Subscription {
  filters: NostrFilter[];
  push(event: NostrEvent): void;
}

/** An in-memory relay with `req` and `event`, as NConnectSigner uses them. */
export class MemoryConnectRelay implements NRelay {
  /** Every event published to it, in order. */
  readonly published: NostrEvent[] = [];
  /** How many times it was closed. */
  closed = 0;
  readonly #subscriptions = new Set<Subscription>();
  /** Listeners that see every event published: the signer apps, which are not counted as subscriptions. */
  readonly #listeners = new Set<(event: NostrEvent) => void>();
  #next = 0;

  /** How many subscriptions the app has open now. */
  get openSubscriptions(): number {
    return this.#subscriptions.size;
  }

  /** The filters of the subscriptions open now. */
  get openFilters(): NostrFilter[][] {
    return [...this.#subscriptions].map((subscription) => subscription.filters);
  }

  async *req(filters: NostrFilter[], opts: { signal?: AbortSignal } = {}): AsyncGenerator<Message> {
    const { signal } = opts;
    const id = `sub-${(this.#next += 1)}`;
    const queue: NostrEvent[] = [];
    let wake: (() => void) | undefined;
    const subscription: Subscription = {
      filters,
      push: (event) => {
        queue.push(event);
        wake?.();
      },
    };
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    this.#subscriptions.add(subscription);
    try {
      // Nothing of this kind is kept, so the stored events end at once.
      yield ["EOSE", id];
      for (;;) {
        // As NRelay1 does, an aborted request ends with an AbortError.
        if (signal?.aborted) throw new DOMException("The signal has been aborted", "AbortError");
        const event = queue.shift();
        if (event !== undefined) {
          yield ["EVENT", id, event];
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      this.#subscriptions.delete(subscription);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async event(event: NostrEvent, opts: { signal?: AbortSignal } = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    this.published.push(event);
    for (const subscription of [...this.#subscriptions]) {
      if (matchFilters(subscription.filters, event)) subscription.push(event);
    }
    for (const listener of [...this.#listeners]) listener(event);
  }

  async query(): Promise<NostrEvent[]> {
    return [];
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  /** Calls `listener` with each event published from now on, until the returned function is called. */
  listen(listener: (event: NostrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** How the signer app answers each request. */
export interface SignerAppBehaviour {
  /**
   * Its answer to a nostrconnect link it scans: the link's secret, as it should; another secret; "ack",
   * which a nostrconnect answer may not be; or nothing at all (it was closed before it answered).
   */
  connectReply?: "secret" | "wrong-secret" | "ack" | "none";
  /** Its answer to get_public_key: the person's key, an error (the person said no), or nothing. */
  getPublicKey?: "answer" | "error" | "none";
}

/** A signer app on a phone, with a person's key, that answers requests on `relay`. */
export interface SignerApp {
  /** The key the app speaks to the connection with (NIP-46's remote-signer key). */
  readonly remotePubkey: string;
  /** The person's public key, which it signs with. */
  readonly userPubkey: string;
  /** The methods of the requests it has had, in order. */
  readonly requests: string[];
  /** Reads a nostrconnect:// link, as when the person scans it, and answers it. */
  scan(uri: string): Promise<void>;
  /** A bunker:// link to it, with `secret`, that the person pastes into the app; it serves from now on. */
  bunkerLink(opts?: { relay?: string; secret?: string }): string;
  /** Stops answering. */
  stop(): void;
}

/**
 * A signer app on a phone over `relay`. The key it speaks with is not the person's (NIP-46 allows the
 * two to differ), so a test can tell which one the app takes for the person.
 */
export function createSignerApp(relay: MemoryConnectRelay, behaviour: SignerAppBehaviour = {}): SignerApp {
  const remoteKey = generateSecretKey();
  const userKey = generateSecretKey();
  const remote = new NSecSigner(remoteKey);
  const remotePubkey = getPublicKey(remoteKey);
  const userPubkey = getPublicKey(userKey);
  const requests: string[] = [];
  let bunkerSecret: string | undefined;

  const respond = async (to: string, response: { id: string; result: string; error?: string }) => {
    const content = await remote.nip44.encrypt(to, JSON.stringify(response));
    const event = finalizeEvent({ kind: CONNECT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", to]], content }, remoteKey);
    await relay.event(event);
  };

  const answer = async (event: NostrEvent) => {
    if (event.kind !== CONNECT_KIND || !event.tags.some((tag) => tag[0] === "p" && tag[1] === remotePubkey)) return;
    let request: { id: string; method: string; params: string[] };
    try {
      request = JSON.parse(await remote.nip44.decrypt(event.pubkey, event.content)) as typeof request;
    } catch {
      return;
    }
    requests.push(request.method);
    switch (request.method) {
      case "connect": {
        const [, secret] = request.params;
        if (bunkerSecret !== undefined && secret !== bunkerSecret) {
          await respond(event.pubkey, { id: request.id, result: "", error: "That is not the secret" });
        } else {
          await respond(event.pubkey, { id: request.id, result: secret ?? "ack" });
        }
        return;
      }
      case "get_public_key": {
        const how = behaviour.getPublicKey ?? "answer";
        if (how === "answer") await respond(event.pubkey, { id: request.id, result: userPubkey });
        if (how === "error") await respond(event.pubkey, { id: request.id, result: "", error: "Not allowed" });
        return;
      }
      case "sign_event": {
        const template = JSON.parse(request.params[0] ?? "{}") as Parameters<typeof finalizeEvent>[0];
        await respond(event.pubkey, { id: request.id, result: JSON.stringify(finalizeEvent(template, userKey)) });
        return;
      }
      case "ping":
        await respond(event.pubkey, { id: request.id, result: "pong" });
        return;
      default:
        await respond(event.pubkey, { id: request.id, result: "", error: `No ${request.method}` });
    }
  };

  let stopListening: (() => void) | undefined;
  const serve = () => {
    stopListening ??= relay.listen((event) => {
      void answer(event);
    });
  };

  return {
    remotePubkey,
    userPubkey,
    requests,
    async scan(uri) {
      const url = new URL(uri);
      if (url.protocol !== "nostrconnect:") throw new Error(`Not a nostrconnect link: ${uri}`);
      const appPubkey = url.hostname || url.pathname.replace(/^\/\//, "");
      const secret = url.searchParams.get("secret") ?? "";
      serve();
      const how = behaviour.connectReply ?? "secret";
      if (how === "none") return;
      const result = how === "secret" ? secret : how === "ack" ? "ack" : `${secret}-not`;
      await respond(appPubkey, { id: crypto.randomUUID(), result });
    },
    bunkerLink({ relay: at = "wss://relay.nsec.app", secret = "s3cret" } = {}) {
      bunkerSecret = secret;
      serve();
      const params = new URLSearchParams({ relay: at, secret });
      return `bunker://${remotePubkey}?${params.toString()}`;
    },
    stop() {
      stopListening?.();
      stopListening = undefined;
    },
  };
}
