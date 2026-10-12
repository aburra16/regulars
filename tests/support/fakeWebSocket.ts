/*
 * A stand-in for the browser's WebSocket, for the tests that run the app's reader and writer
 * (src/nostr/relayReader.ts) over Nostrify's own relay and websocket-ts, as they are installed
 * (tests/relayWriter.test.ts, tests/relayReaderSocket.test.ts). A test puts it in the browser's place
 * (`vi.stubGlobal("WebSocket", FakeWebSocket)`), and nothing reaches the network.
 */

/**
 * The browser's WebSocket as websocket-ts and NRelay1 use it, held in memory: the test opens it,
 * answers on it, or loses it. Its states are on the class and on each socket, as a browser's are:
 * NRelay1 reads the one, websocket-ts the other.
 */
export class FakeWebSocket extends EventTarget {
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
