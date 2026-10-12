import { NRelay1 } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { FOLLOW_READ_MS, readFollowList } from "../src/follow/read";
import { CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS, readerFor } from "../src/nostr/relayReader";
import { FakeWebSocket } from "./support/fakeWebSocket";

/*
 * The app's reader (src/nostr/relayReader.ts) over Nostrify's own relay and websocket-ts, as they are
 * installed, with a stand-in for the browser's WebSocket underneath: nothing reaches the network, and
 * the reader's limits run on a fake clock. (tests/relayReader.test.ts has the limits themselves, over
 * a stand-in for Nostrify's relay; tests/relayWriter.test.ts the writer, over this same socket.)
 *
 * What these hold is what a read does when its connection is lost. Nostrify's relay makes the
 * connection again by itself, and the reader waits for it under its limits: that is every read's
 * patience, and stays so. A read that asks not to wait (`failFast`, ruling R40) ends at once instead,
 * with a NetworkError as the writer's, when the connection is lost before the relay has said
 * anything on it; once it has, that read too goes on under the same limits.
 */

const URL = "wss://relay.example.test";
const key = generateSecretKey();
const AUTHOR = getPublicKey(key);
/** A follow list, signed, as the relay's own check of signatures needs. */
const list = finalizeEvent({ kind: 3, created_at: 1_800_000_000, tags: [], content: "" }, key);
const FILTER = { kinds: [3], authors: [AUTHOR], limit: 1 };

/** How long websocket-ts waits before it makes a lost connection again, the first time: Nostrify's backoff of 1 s, doubled. */
const FIRST_RETRY_MS = 2_000;

/**
 * Starts a read of `URL` with the app's reader, as every read is made unless `opts` says otherwise,
 * and the browser's socket it opened, at once; the ids of the events it gave, and how it ended, once
 * it has.
 */
function startRead(opts?: { failFast?: boolean }, signal = new AbortController().signal) {
  const events: string[] = [];
  let outcome: "pending" | "done" | { error: unknown } = "pending";
  void (async () => {
    try {
      // A read that gives no options is made with none, as every read was before there were any.
      const reading = opts === undefined ? readerFor(URL).req(FILTER, signal) : readerFor(URL).req(FILTER, signal, opts);
      for await (const value of reading) events.push(value.id);
      outcome = "done";
    } catch (error) {
      outcome = { error };
    }
  })();
  return {
    socket: FakeWebSocket.made.at(-1)!,
    events,
    get outcome() {
      return outcome;
    },
  };
}

/** The id of the request the reader sent on `socket`, once the connection is open. */
function requestOn(socket: FakeWebSocket): string {
  const sent = socket.sent.map((text) => JSON.parse(text) as unknown[]).find((msg) => msg[0] === "REQ");
  expect(sent).toEqual(["REQ", expect.any(String), FILTER]);
  return sent![1] as string;
}

/** Lets every message and event that is due land, moving the clock on by nothing. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/**
 * Lets everything that can go on without the clock go on: a turn of the event loop, which the fake
 * clock does not stand in for. No timer runs, and none is moved.
 */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The error a read ended with. */
const errorOf = (read: { outcome: unknown }) => (read.outcome as { error: DOMException }).error;

beforeEach(() => {
  FakeWebSocket.made = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readerFor over Nostrify's own relay", () => {
  it("opens one connection, asks once it is open, gives what the relay sends, ends at EOSE and closes it", async () => {
    const read = startRead();
    expect(FakeWebSocket.made).toHaveLength(1);
    expect(read.socket.url).toBe(URL);
    expect(read.socket.sent).toEqual([]);

    read.socket.open();
    const request = requestOn(read.socket);
    read.socket.receive(["EVENT", request, list]);
    read.socket.receive(["EOSE", request]);
    await settle();

    expect(read.outcome).toBe("done");
    expect(read.events).toEqual([list.id]);
    expect(read.socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a read, when its connection is lost: today's patience", () => {
  it.each([
    ["is refused: it fails, and closes, before it opens", (socket: FakeWebSocket) => socket.lose("error")],
    ["closes before it opens", (socket: FakeWebSocket) => socket.lose("close")],
    [
      "closes once open, before the relay has said anything",
      (socket: FakeWebSocket) => {
        socket.open();
        socket.lose("close");
      },
    ],
  ])("waits out its 20 s to the first message when the connection %s, and then says the relay did not answer", async (_, lose) => {
    const read = startRead();
    lose(read.socket);
    await settle();
    expect(read.outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(read.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(errorOf(read)).toBeInstanceOf(DOMException);
    expect(errorOf(read).name).toBe("TimeoutError");
    expect(errorOf(read).message).toBe(`${URL} did not answer`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is answered by a relay that comes back: the connection is made again by itself, and the request is sent on it", async () => {
    const read = startRead();
    read.socket.lose("error");
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
    expect(FakeWebSocket.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.made).toHaveLength(2);
    expect(read.outcome).toBe("pending");

    const again = FakeWebSocket.made[1]!;
    again.open();
    const request = requestOn(again);
    again.receive(["EVENT", request, list]);
    again.receive(["EOSE", request]);
    await settle();

    expect(read.outcome).toBe("done");
    expect(read.events).toEqual([list.id]);
  });

  it("waits 20 s from the relay's last message when the connection is lost after it, and then says the relay went quiet", async () => {
    const read = startRead();
    read.socket.open();
    await vi.advanceTimersByTimeAsync(5_000);
    read.socket.receive(["EVENT", requestOn(read.socket), list]);
    await settle();
    read.socket.lose("close");

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(read.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(errorOf(read).name).toBe("TimeoutError");
    expect(errorOf(read).message).toBe(`${URL} went quiet`);
    expect(read.events).toEqual([list.id]);
  });

  it("listens on the browser's socket for nothing of its own: only websocket-ts does", async () => {
    const probe = new NRelay1(URL);
    const bare = FakeWebSocket.made[0]!;
    const theirs = { close: bare.listeners("close"), error: bare.listeners("error") };
    void probe.close().catch(() => {});

    const read = startRead();

    expect({ close: read.socket.listeners("close"), error: read.socket.listeners("error") }).toEqual(theirs);
    read.socket.open();
    read.socket.receive(["EOSE", requestOn(read.socket)]);
    await settle();
    expect(read.outcome).toBe("done");
  });
});

/** The ways a connection is lost before the relay has said anything on it. */
const LOST_UNHEARD: [string, (socket: FakeWebSocket) => void][] = [
  ["is refused: it fails, and closes, before it opens", (socket) => socket.lose("error")],
  ["fails before it opens", (socket) => socket.dispatchEvent(new Event("error"))],
  ["closes before it opens", (socket) => socket.lose("close")],
  [
    "closes once open, before the relay has said anything",
    (socket) => {
      socket.open();
      socket.lose("close");
    },
  ],
  [
    "closes after an AUTH challenge and nothing else: that is no word about the request",
    (socket) => {
      socket.open();
      socket.receive(["AUTH", "a-challenge"]);
      socket.lose("close");
    },
  ],
];

describe("a read that asks not to wait on a relay that is out (failFast, ruling R40)", () => {
  it.each(LOST_UNHEARD)("ends at once with a NetworkError when the connection %s", async (_, lose) => {
    const read = startRead({ failFast: true });
    lose(read.socket);
    // No timer is moved: not the reader's limits, nor the wait before the connection is made again.
    await turn();

    expect(errorOf(read)).toBeInstanceOf(DOMException);
    expect(errorOf(read).name).toBe("NetworkError");
    expect(errorOf(read).message).toBe(`${URL} lost its connection before it answered`);
    expect(read.events).toEqual([]);
    // Nothing of it is left: its limits are stopped, the connection is closed and is not made again.
    expect(vi.getTimerCount()).toBe(0);
    expect(read.socket.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(FakeWebSocket.made).toHaveLength(1);
  });

  it("reads as any read does from a relay that answers", async () => {
    const read = startRead({ failFast: true });
    read.socket.open();
    const request = requestOn(read.socket);
    read.socket.receive(["EVENT", request, list]);
    read.socket.receive(["EOSE", request]);
    await turn();

    expect(read.outcome).toBe("done");
    expect(read.events).toEqual([list.id]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes on under the read's limits once the relay has sent an event, though the connection is lost then: it is made again, and the read ends at EOSE", async () => {
    const read = startRead({ failFast: true });
    read.socket.open();
    read.socket.receive(["EVENT", requestOn(read.socket), list]);
    await turn();
    read.socket.lose("close");
    await turn();
    expect(read.outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(FakeWebSocket.made).toHaveLength(2);
    const again = FakeWebSocket.made[1]!;
    again.open();
    again.receive(["EOSE", requestOn(again)]);
    await turn();

    expect(read.outcome).toBe("done");
    expect(read.events).toEqual([list.id]);
  });

  it("waits its 20 s from the relay's last message, as any read, when the connection is lost after it and does not come back", async () => {
    const read = startRead({ failFast: true });
    read.socket.open();
    read.socket.receive(["EVENT", requestOn(read.socket), list]);
    await turn();
    read.socket.lose("error");

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(read.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(errorOf(read).name).toBe("TimeoutError");
    expect(errorOf(read).message).toBe(`${URL} went quiet`);
  });

  it("counts an event the reader does not pass on as the relay having spoken: one whose signature fails", async () => {
    const read = startRead({ failFast: true });
    read.socket.open();
    read.socket.receive(["EVENT", requestOn(read.socket), { ...list, sig: "0".repeat(128) }]);
    read.socket.lose("close");
    await turn();

    expect(read.outcome).toBe("pending");
    expect(read.events).toEqual([]);
  });

  it.each([
    ["a notice", (socket: FakeWebSocket) => socket.receive(["NOTICE", "rate limited"]), `${URL} sent a notice: rate limited`],
    [
      "that it closed the request",
      (socket: FakeWebSocket) => socket.receive(["CLOSED", requestOn(socket), "error: shutting down"]),
      `${URL} closed the request before the end of its stored events`,
    ],
  ])("ends with what the relay said, not with a NetworkError, when it sends %s and then closes the connection", async (_, say, message) => {
    const read = startRead({ failFast: true });
    read.socket.open();
    say(read.socket);
    read.socket.lose("close");
    await turn();

    expect(errorOf(read).name).not.toBe("NetworkError");
    expect(errorOf(read).message).toBe(message);
  });

  it("listens on the browser's socket while it reads, and leaves nothing of its own there once it has ended", async () => {
    const probe = new NRelay1(URL);
    const bare = FakeWebSocket.made[0]!;
    const theirs = { close: bare.listeners("close"), error: bare.listeners("error") };
    void probe.close().catch(() => {});

    const read = startRead({ failFast: true });
    expect({ close: read.socket.listeners("close"), error: read.socket.listeners("error") }).toEqual({ close: theirs.close + 1, error: theirs.error + 1 });
    read.socket.open();
    read.socket.receive(["EOSE", requestOn(read.socket)]);
    await turn();

    expect(read.outcome).toBe("done");
    expect({ close: read.socket.listeners("close"), error: read.socket.listeners("error") }).toEqual(theirs);
  });

  it("ends with the caller's reason when the caller stops it first", async () => {
    const stop = new AbortController();
    const read = startRead({ failFast: true }, stop.signal);
    const reason = new Error("signed out");
    stop.abort(reason);
    read.socket.lose("error");
    await turn();

    expect(read.outcome).toEqual({ error: reason });
  });

  it("waits out the read's limits, as it did before, when the socket under Nostrify's relay cannot be found (an upgrade moved it)", async () => {
    const probe = new NRelay1(URL);
    const sockets = Object.getPrototypeOf(probe.socket) as typeof probe.socket;
    vi.spyOn(sockets, "underlyingWebsocket", "get").mockReturnValue(undefined as unknown as WebSocket);
    void probe.close().catch(() => {});

    const read = startRead({ failFast: true });
    read.socket.lose("error");
    await turn();
    expect(read.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);

    expect(errorOf(read).name).toBe("TimeoutError");
  });
});

describe("a read that gives no option, or says it will wait", () => {
  it.each([
    ["no option", undefined],
    ["an empty one", {}],
    ["failFast false", { failFast: false }],
  ])("waits out its 20 s on a refused connection with %s, exactly as before", async (_, opts) => {
    const read = startRead(opts);
    read.socket.lose("error");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(read.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(errorOf(read).name).toBe("TimeoutError");
    expect(errorOf(read).message).toBe(`${URL} did not answer`);
  });
});

describe("a follow list read from three relays, one of them out (ruling R40)", () => {
  const [A, B, C] = ["wss://a.example.test", "wss://b.example.test", "wss://c.example.test"];

  it("has its answer from the two that answer without any timer being advanced: the one that is out is left at once", async () => {
    config.relayReadExtras = {};
    let read: Awaited<ReturnType<typeof readFollowList>> | undefined;
    void readFollowList(AUTHOR, [A!, B!, C!], (url) => readerFor(url), new AbortController().signal).then((found) => {
      read = found;
    });
    await turn();
    const [a, b, c] = [A, B, C].map((url) => FakeWebSocket.made.find((socket) => socket.url === url)!);
    expect(FakeWebSocket.made).toHaveLength(3);

    // A refuses the connection. B has the list, and C has none.
    a!.lose("error");
    b!.open();
    b!.receive(["EVENT", requestOn(b!), list]);
    b!.receive(["EOSE", requestOn(b!)]);
    c!.open();
    c!.receive(["EOSE", requestOn(c!)]);
    await turn();

    expect(read?.answered).toEqual([B, C]);
    expect(read?.list?.id).toBe(list.id);
    // Not one timer ran for it, and none is left: each relay's own limit was let go of as it ended.
    expect(vi.getTimerCount()).toBe(0);
    expect(FOLLOW_READ_MS).toBe(6_000);
  });
});
