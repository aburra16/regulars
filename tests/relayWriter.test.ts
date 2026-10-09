import { NRelay1 } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writerFor } from "../src/nostr/relayReader";

/*
 * The app's writer (src/nostr/relayReader.ts) over Nostrify's own relay and websocket-ts, as they are
 * installed, with a stand-in for the browser's WebSocket underneath: nothing reaches the network. The
 * writer listens on the browser's socket for the connection being lost, which NRelay1 does not tell an
 * event waiting for its OK, and reaches it as `relay.socket.underlyingWebsocket`. An upgrade of
 * Nostrify or websocket-ts that moves it fails here.
 */

/**
 * The browser's WebSocket as websocket-ts and NRelay1 use it, held in memory: the test opens it,
 * answers on it, or loses it. Its states are on the class and on each socket, as a browser's are:
 * NRelay1 reads the one, websocket-ts the other.
 */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket made, in order. */
  static made: FakeWebSocket[] = [];

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  /** What was sent on it, in order. */
  readonly sent: string[] = [];
  /** The listeners on it now, by event. */
  private readonly heard = new Map<string, Set<unknown>>();

  constructor(readonly url: string) {
    super();
    FakeWebSocket.made.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options);
    if (!this.heard.has(type)) this.heard.set(type, new Set());
    this.heard.get(type)!.add(listener);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, listener, options);
    this.heard.get(type)?.delete(listener);
  }

  /** How many listeners `type` has on it now. */
  listeners(type: string): number {
    return this.heard.get(type)?.size ?? 0;
  }

  /** Closed from this end: closed a moment later, as a browser's is. Nothing once it is closing. */
  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    });
  }

  /** The relay takes the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** The relay sends `msg`. */
  receive(msg: unknown[]): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }

  /** The connection is lost: the relay closes it, or it fails, which a browser follows with a close. */
  lose(how: "close" | "error"): void {
    if (how === "error") this.dispatchEvent(new Event("error"));
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const URL = "wss://relay.example.test";
const event = finalizeEvent({ kind: 1, created_at: 1_800_000_000, tags: [], content: "Get the bolo" }, generateSecretKey());

/** Starts sending `event` to `URL` with the app's writer, and the browser's socket it opened, at once. */
function startPublish() {
  const sending = writerFor(URL).publish(event, new AbortController().signal);
  sending.catch(() => {});
  return { sending, socket: FakeWebSocket.made.at(-1)! };
}

beforeEach(() => {
  FakeWebSocket.made = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Lets every message and event that is due land. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("writerFor over Nostrify's own relay", () => {
  it("finds the browser's socket under Nostrify's relay, as socket.underlyingWebsocket", async () => {
    const relay = new NRelay1(URL);
    try {
      expect(relay.socket.underlyingWebsocket).toBeInstanceOf(FakeWebSocket);
      expect(relay.socket.underlyingWebsocket).toBe(FakeWebSocket.made[0]);
    } finally {
      await relay.close();
    }
  });

  it("sends the event once the connection opens, and is done when the relay takes it", async () => {
    const { sending, socket } = startPublish();
    expect(socket.url).toBe(URL);
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify(["EVENT", event])]);
    socket.receive(["OK", event.id, true, ""]);
    await expect(sending).resolves.toBeUndefined();
  });

  it("fails with the relay's reason when it refuses the event", async () => {
    const { sending, socket } = startPublish();
    socket.open();
    socket.receive(["OK", event.id, false, "error: vespa feed 503"]);
    await expect(sending).rejects.toThrow("error: vespa feed 503");
  });

  it.each([
    ["closes", "close"],
    ["fails", "error"],
  ] as const)("fails at once with a NetworkError when the connection %s before the relay answers", async (_, how) => {
    const { sending, socket } = startPublish();
    socket.open();
    socket.lose(how);
    const error = await sending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("NetworkError");
    // The relay is named where the warning is written (src/review/post.ts), not here as well.
    expect((error as DOMException).message).toBe("The connection was lost before the relay answered");
  });

  it("closes the connection once the relay has taken the event, and leaves none of its own listeners on the socket", async () => {
    const { sending, socket } = startPublish();
    socket.open();
    const during = { close: socket.listeners("close"), error: socket.listeners("error") };
    socket.receive(["OK", event.id, true, ""]);
    await expect(sending).resolves.toBeUndefined();
    await settle();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    // The writer's own two, one on close and one on error, are gone; websocket-ts keeps its own.
    expect({ close: socket.listeners("close"), error: socket.listeners("error") }).toEqual({ close: during.close - 1, error: during.error - 1 });
  });

  it("waits out the try, as it did before, when the socket under Nostrify's relay cannot be found (an upgrade moved it)", async () => {
    const probe = new NRelay1(URL);
    // websocket-ts's getter, on every socket of its: gone, as an upgrade might leave it.
    const sockets = Object.getPrototypeOf(probe.socket) as typeof probe.socket;
    vi.spyOn(sockets, "underlyingWebsocket", "get").mockReturnValue(undefined as unknown as WebSocket);
    void probe.close().catch(() => {});

    // It is taken as before.
    const taken = startPublish();
    taken.socket.open();
    taken.socket.receive(["OK", event.id, true, ""]);
    await expect(taken.sending).resolves.toBeUndefined();

    // A lost connection is not seen: the try waits until its signal aborts, with no error of its own.
    const controller = new AbortController();
    let outcome: unknown = "pending";
    void writerFor(URL)
      .publish(event, controller.signal)
      .catch((error: unknown) => (outcome = error));
    const socket = FakeWebSocket.made.at(-1)!;
    socket.open();
    socket.lose("close");
    await settle();
    expect(outcome).toBe("pending");
    const reason = new DOMException("The try's time is up", "TimeoutError");
    controller.abort(reason);
    await settle();
    expect(outcome).toBe(reason);
  });

  it("fails at once with a NetworkError when the connection is lost before it opens", async () => {
    const { sending, socket } = startPublish();
    socket.lose("error");
    await expect(sending).rejects.toMatchObject({ name: "NetworkError" });
    // Nothing was sent: the event waited for the connection, which never opened.
    expect(socket.sent).toEqual([]);
  });
});
