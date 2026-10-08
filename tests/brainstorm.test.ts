import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUEST_TIMEOUT_MS } from "../src/account/connect";
import { SESSION_KEY } from "../src/account/session";
import {
  ANSWER_WAIT_MS,
  LOCK_WAIT_MS,
  LOGIN_KIND,
  latestRun,
  NotSigned,
  type Run,
  type RunStatus,
  runState,
  SIGN_IN_LOCK,
  SIGN_WAIT_MS,
  SignInRefused,
  scorerOf,
  signInToBrainstorm,
  startRun,
  TokenExpired,
  Unavailable,
} from "../src/circle/brainstorm";
import { forgetToken, readToken, saveToken, TOKEN_KEY } from "../src/circle/token";
import { config } from "../src/config";
import { SIGN_TIMEOUT_MS } from "../src/review/post";

/*
 * The Brainstorm client (M3 Task 1): signing Brainstorm's login and trading it for a token, reading
 * and starting the person's GrapeRank run, and finding their scorer. Brainstorm is played by a fake
 * `fetch` that answers as brainstorm_server dc8c4f3 does (one challenge per person, the newest wins);
 * nothing reaches the network. Two tabs are two copies of the module, sharing one browser's locks.
 */

const API = "https://api.brainstorm.world";

const KEY = generateSecretKey();
const PK = getPublicKey(KEY);
const OTHER_PK = "b".repeat(64);

/** A scorer's key, made up: Brainstorm's real ones are never written into the app or its tests. */
const SCORER = "5c0e".repeat(16);

/** A token as Brainstorm gives one: a JWT, three parts. Made up. */
const tokenNumber = (n: number) => `eyJhbGciOiJIUzI1NiJ9.eyJuIjo${n}fQ.c2lnbmF0dXJl${n}`;
const TOKEN = tokenNumber(0);

/** Brainstorm's fixed time for these tests: 2026-10-08 12:00:00 UTC. */
const NOW_MS = Date.UTC(2026, 9, 8, 12, 0, 0);

// ---------------------------------------------------------------------------------------------
// Brainstorm, played in memory.
// ---------------------------------------------------------------------------------------------

interface Asked {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
}

type Answer = Response | "network error" | "never";
type Route = (asked: Asked) => Answer | Promise<Answer>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A run as `/user/graperankResult` sends one (BrainstormRequestInstance), password and all. */
function wireRun(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    created_at: "2026-10-08T11:40:00.123456",
    updated_at: "2026-10-08T11:52:30",
    private_id: 4321,
    status: "ongoing",
    ta_status: "waiting",
    internal_publication_status: "waiting",
    count_values: "",
    password: "the-run-password",
    algorithm: "graperank",
    parameters: PK,
    how_many_others_with_priority: 3,
    pubkey: PK,
    trigger_source: "manual",
    graperank_preset_used: null,
    graperank_params: null,
    error: null,
    ...fields,
  };
}

/**
 * Brainstorm as brainstorm_server dc8c4f3 answers: one challenge per person, which a new one
 * replaces; a verify that checks the author, the `t` and `challenge` tags and the signature, then
 * gives a token. The run and setup routes answer as each test says (`routes`).
 */
function brainstorm() {
  const asked: Asked[] = [];
  const challengeOf = new Map<string, string>();
  let challenges = 0;
  let tokens = 0;
  const routes: Record<string, Route> = {
    "GET /authChallenge/:pk": (req) => {
      challenges += 1;
      const challenge = challenges.toString(16).padStart(32, "0");
      challengeOf.set(pkOf(req.url), challenge);
      return json(200, { code: 200, message: null, data: { challenge } });
    },
    "POST /authChallenge/:pk/verify": (req) => {
      const pk = pkOf(req.url);
      const challenge = challengeOf.get(pk);
      if (challenge === undefined) return json(400, { detail: "No challenge found or expired" });
      const event = (req.body as { signed_event: NostrEvent }).signed_event;
      const t = event.tags.find((tag) => tag[0] === "t");
      const c = event.tags.find((tag) => tag[0] === "challenge");
      if (event.pubkey !== pk || t?.[1] !== "brainstorm_login" || c?.[1] !== challenge || !verifyEvent({ ...event })) {
        return json(401, { detail: "Invalid event" });
      }
      challengeOf.delete(pk);
      tokens += 1;
      return json(200, { code: 200, message: null, data: { token: tokenNumber(tokens) } });
    },
  };

  function pkOf(url: string): string {
    return /\/authChallenge\/([0-9a-f]{64})/.exec(url)?.[1] ?? "";
  }

  function routeOf(method: string, url: string): string {
    const path = new URL(url).pathname
      .replace(/^\/authChallenge\/[0-9a-f]{64}/, "/authChallenge/:pk")
      .replace(/^\/setup\/[0-9a-f]{64}$/, "/setup/:pk");
    return `${method} ${path}`;
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(`${API}/`)) throw new Error(`A test asked ${url}: only Brainstorm is played here`);
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const req: Asked = {
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      credentials: init.credentials,
      cache: init.cache,
    };
    asked.push(req);
    const route = routes[routeOf(req.method, url)];
    if (route === undefined) throw new Error(`No route for ${req.method} ${url} in this test`);
    const answer = await route(req);
    if (answer === "network error") throw new TypeError("Failed to fetch");
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (answer !== "never") resolve(answer);
    });
  });

  return {
    fetch,
    asked,
    routes,
    /** The challenge Brainstorm keeps for `pk` now, if any. */
    challengeFor: (pk: string) => challengeOf.get(pk),
  };
}

// ---------------------------------------------------------------------------------------------
// The browser around it: its locks (Web Locks), shared by every tab.
// ---------------------------------------------------------------------------------------------

/** `navigator.locks` as a browser has it, for exclusive locks: one holder per name, the others waiting in turn. */
class FakeLocks {
  readonly requests: string[] = [];
  readonly #held = new Set<string>();
  readonly #queues = new Map<string, Array<() => void>>();

  async request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    this.requests.push(name);
    const { signal } = options;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (!this.#held.has(name)) {
        this.#held.add(name);
        resolve();
        return;
      }
      const queue = this.#queues.get(name) ?? [];
      this.#queues.set(name, queue);
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        queue.splice(queue.indexOf(grant), 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(grant);
    });
    try {
      return await callback();
    } finally {
      const next = this.#queues.get(name)?.shift();
      if (next !== undefined) next();
      else this.#held.delete(name);
    }
  }
}

let locks: FakeLocks;

function useLocks(value: FakeLocks | undefined) {
  Object.defineProperty(window.navigator, "locks", { configurable: true, value });
}

/** A tab of the app: a copy of the client of its own, as another tab has. */
async function openTab(): Promise<typeof import("../src/circle/brainstorm")> {
  vi.resetModules();
  return import("../src/circle/brainstorm");
}

// ---------------------------------------------------------------------------------------------
// The person, and their signer.
// ---------------------------------------------------------------------------------------------

/** A signer as an add-on is: it signs with the person's key, after `delayMs` when given. */
function signerOf(key = KEY, delayMs = 0): NostrSigner & { signEvent: ReturnType<typeof vi.fn> } {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return finalizeEvent({ ...template }, key);
    }),
  };
}

/** Signs the person in to Regulars in this tab, as a session kept by the tab says. */
function signedIn(pubkey = PK) {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
}

const never = () => new AbortController().signal;

let server: ReturnType<typeof brainstorm>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  server = brainstorm();
  vi.stubGlobal("fetch", server.fetch);
  locks = new FakeLocks();
  useLocks(locks);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useLocks(undefined);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("Brainstorm's address", () => {
  it("is api.brainstorm.world, in the config", () => {
    expect(config.brainstormApi).toBe(API);
  });
});

describe("asking Brainstorm nothing until asked (Review Focus 1)", () => {
  it("makes no request and takes no lock when the code is loaded", async () => {
    vi.resetModules();
    await import("../src/circle/brainstorm");
    await import("../src/circle/token");
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS * 2);

    expect(server.fetch).not.toHaveBeenCalled();
    expect(locks.requests).toEqual([]);
  });

  it("asks only when a function is called, and then only what it asks", async () => {
    const client = await openTab();
    expect(server.fetch).not.toHaveBeenCalled();

    server.routes["GET /setup/:pk"] = () => json(404, { detail: null });
    await client.scorerOf(PK, never());

    expect(server.asked.map((req) => `${req.method} ${req.url}`)).toEqual([`GET ${API}/setup/${PK}`]);
  });
});

describe("signInToBrainstorm", () => {
  it("signs exactly Brainstorm's login: kind 22242, its t and challenge tags, no words, now", async () => {
    const signer = signerOf();
    await signInToBrainstorm(PK, signer, never());

    expect(LOGIN_KIND).toBe(22242);
    expect(signer.signEvent).toHaveBeenCalledTimes(1);
    expect(signer.signEvent.mock.calls[0]![0]).toEqual({
      kind: 22242,
      created_at: NOW_MS / 1000,
      tags: [
        ["t", "brainstorm_login"],
        ["challenge", "00000000000000000000000000000001"],
      ],
      content: "",
    });
  });

  it("gets a challenge, then sends the signed login, and gives back the token", async () => {
    const signer = signerOf();
    const token = await signInToBrainstorm(PK, signer, never());

    expect(token).toBe(tokenNumber(1));
    const signed = (await signer.signEvent.mock.results[0]!.value) as NostrEvent;
    expect(server.asked).toEqual([
      {
        method: "GET",
        url: `${API}/authChallenge/${PK}`,
        headers: {},
        body: undefined,
        credentials: "omit",
        cache: "no-store",
      },
      {
        method: "POST",
        url: `${API}/authChallenge/${PK}/verify`,
        headers: { "content-type": "application/json" },
        body: {
          signed_event: {
            id: signed.id,
            pubkey: PK,
            created_at: signed.created_at,
            kind: 22242,
            tags: signed.tags,
            content: "",
            sig: signed.sig,
          },
        },
        credentials: "omit",
        cache: "no-store",
      },
    ]);
  });

  it("sends the login as the signer signed it, with a tag the signer adds after Brainstorm's", async () => {
    const signer = signerOf();
    signer.signEvent.mockImplementationOnce(async (template: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...template, tags: [...template.tags, ["client", "an add-on"]] }, KEY),
    );

    await expect(signInToBrainstorm(PK, signer, never())).resolves.toBe(tokenNumber(1));
    const sent = (server.asked[1]!.body as { signed_event: NostrEvent }).signed_event;
    expect(sent.tags).toEqual([
      ["t", "brainstorm_login"],
      ["challenge", "00000000000000000000000000000001"],
      ["client", "an add-on"],
    ]);
  });

  it("sends nothing when the signer signs something else: another person, kind, tag or words (NotSigned)", async () => {
    const changes: Array<(template: Parameters<typeof finalizeEvent>[0]) => NostrEvent> = [
      (template) => finalizeEvent({ ...template }, generateSecretKey()),
      (template) => finalizeEvent({ ...template, kind: 1 }, KEY),
      (template) => finalizeEvent({ ...template, tags: [["challenge", "ffff"], ["t", "brainstorm_login"]] }, KEY),
      (template) => finalizeEvent({ ...template, tags: [["t", "brainstorm_login"]] }, KEY),
      (template) => finalizeEvent({ ...template, content: "hello" }, KEY),
      () => ({ id: "x" }) as unknown as NostrEvent,
    ];
    for (const change of changes) {
      const signer = signerOf();
      signer.signEvent.mockImplementationOnce(async (template: Parameters<typeof finalizeEvent>[0]) => change(template));
      await expect(signInToBrainstorm(PK, signer, never())).rejects.toBeInstanceOf(NotSigned);
    }
    expect(server.asked.filter((req) => req.method === "POST")).toEqual([]);
  });

  it("gives up on a signer that does not answer: an add-on after a minute, a phone app after two (NotSigned)", async () => {
    expect(SIGN_WAIT_MS).toEqual({ browser: SIGN_TIMEOUT_MS, phone: REQUEST_TIMEOUT_MS });
    expect(SIGN_WAIT_MS).toEqual({ browser: 60_000, phone: 120_000 });

    for (const how of ["browser", "phone"] as const) {
      const signer = signerOf();
      signer.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
      const signing = signInToBrainstorm(PK, signer, never(), { how });
      const outcome = signing.then(
        () => "signed",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(SIGN_WAIT_MS[how] - 1);
      expect(await Promise.race([outcome, Promise.resolve("still waiting")])).toBe("still waiting");
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(NotSigned);
    }
    // A signer whose way is not said has a phone app's time.
    const signer = signerOf();
    signer.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const outcome = signInToBrainstorm(PK, signer, never()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SIGN_WAIT_MS.phone);
    expect(await outcome).toBeInstanceOf(NotSigned);
    expect(server.asked.filter((req) => req.method === "POST")).toEqual([]);
  });

  it("passes on what the signer throws, such as the person saying no, and sends nothing", async () => {
    const no = new Error("The person said no");
    const signer = signerOf();
    signer.signEvent.mockRejectedValueOnce(no);

    await expect(signInToBrainstorm(PK, signer, never())).rejects.toBe(no);
    expect(server.asked.map((req) => req.method)).toEqual(["GET"]);
  });

  it("says Brainstorm refused the login when it has no challenge (400) or finds the event invalid (401)", async () => {
    server.routes["POST /authChallenge/:pk/verify"] = () => json(400, { detail: "No challenge found or expired" });
    await expect(signInToBrainstorm(PK, signerOf(), never())).rejects.toBeInstanceOf(SignInRefused);

    server.routes["POST /authChallenge/:pk/verify"] = () => json(401, { detail: "Invalid event" });
    await expect(signInToBrainstorm(PK, signerOf(), never())).rejects.toBeInstanceOf(SignInRefused);
  });

  it("is unavailable when Brainstorm fails (500), cannot be reached, or answers with something else", async () => {
    const failures: Array<[string, Route]> = [
      ["GET /authChallenge/:pk", () => json(500, { detail: "Internal Server Error" })],
      ["GET /authChallenge/:pk", () => "network error"],
      ["GET /authChallenge/:pk", () => new Response("<html>bad gateway</html>", { status: 200 })],
      ["GET /authChallenge/:pk", () => json(200, { data: { challenge: "" } })],
      ["GET /authChallenge/:pk", () => json(200, { data: { challenge: "not hex!" } })],
      ["POST /authChallenge/:pk/verify", () => json(500, { detail: "Internal Server Error" })],
      ["POST /authChallenge/:pk/verify", () => json(502, "Bad Gateway")],
      ["POST /authChallenge/:pk/verify", () => "network error"],
      ["POST /authChallenge/:pk/verify", () => json(200, { data: { token: "" } })],
      ["POST /authChallenge/:pk/verify", () => json(200, { data: {} })],
    ];
    for (const [route, failure] of failures) {
      server = brainstorm();
      vi.stubGlobal("fetch", server.fetch);
      server.routes[route] = failure;
      await expect(signInToBrainstorm(PK, signerOf(), never()), route).rejects.toBeInstanceOf(Unavailable);
    }
  });

  it("is unavailable when Brainstorm does not answer in time", async () => {
    server.routes["GET /authChallenge/:pk"] = () => "never";
    const outcome = signInToBrainstorm(PK, signerOf(), never()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(await outcome).toBeInstanceOf(Unavailable);
  });

  it("stops with the signal's reason when it aborts, whatever it is waiting for", async () => {
    const stop = new AbortController();
    const signer = signerOf();
    signer.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const outcome = signInToBrainstorm(PK, signer, stop.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("The person left the page");
    stop.abort(reason);
    expect(await outcome).toBe(reason);

    const stopped = new AbortController();
    stopped.abort(reason);
    await expect(signInToBrainstorm(PK, signerOf(), stopped.signal)).rejects.toBe(reason);
  });

  it("refuses a public key that is not one, asking nothing", async () => {
    await expect(signInToBrainstorm("../setup", signerOf(), never())).rejects.toBeInstanceOf(TypeError);
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe("the token", () => {
  it("goes to this tab's sessionStorage only, for the person, and never to localStorage, an address or the console", async () => {
    signedIn();
    const consoles = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) => vi.spyOn(console, method));
    const before = window.location.href;

    const token = await signInToBrainstorm(PK, signerOf(), never());

    expect(JSON.parse(window.sessionStorage.getItem(TOKEN_KEY)!)).toEqual({ pubkey: PK, token });
    expect(TOKEN_KEY).toBe("regulars.brainstorm");
    expect(readToken(PK)).toBe(token);
    expect(window.localStorage.length).toBe(0);
    expect(window.location.href).toBe(before);
    for (const req of server.asked) expect(req.url).not.toContain(token);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    // The only things this tab keeps are the session and the token.
    expect(Object.keys(window.sessionStorage).sort()).toEqual([SESSION_KEY, TOKEN_KEY].sort());
  });

  it("is sent as Authorization: Bearer, and only to the run routes", async () => {
    server.routes["GET /user/graperankResult"] = () => json(200, { code: 200, message: null, data: null });
    server.routes["POST /user/graperank"] = () => json(200, { code: 200, message: null, data: wireRun() });
    server.routes["GET /setup/:pk"] = () => json(404, { detail: null });

    await latestRun(TOKEN, never());
    await startRun(TOKEN, never());
    await scorerOf(PK, never());

    expect(server.asked).toEqual([
      {
        method: "GET",
        url: `${API}/user/graperankResult`,
        headers: { authorization: `Bearer ${TOKEN}` },
        body: undefined,
        credentials: "omit",
        cache: "no-store",
      },
      {
        method: "POST",
        url: `${API}/user/graperank`,
        headers: { authorization: `Bearer ${TOKEN}` },
        body: undefined,
        credentials: "omit",
        cache: "no-store",
      },
      {
        method: "GET",
        url: `${API}/setup/${PK}`,
        headers: {},
        body: undefined,
        credentials: "omit",
        cache: "no-store",
      },
    ]);
  });

  it("is kept per person: another's is not read back, and one written any other way is forgotten", () => {
    signedIn();
    saveToken(PK, TOKEN);
    expect(readToken(OTHER_PK)).toBeNull();

    for (const kept of ["not json", JSON.stringify({ pubkey: PK }), JSON.stringify({ pubkey: PK, token: "no dots" }), JSON.stringify([PK, TOKEN])]) {
      window.sessionStorage.setItem(TOKEN_KEY, kept);
      expect(readToken(PK), kept).toBeNull();
      expect(window.sessionStorage.getItem(TOKEN_KEY), kept).toBeNull();
    }
  });

  it("goes with the session: once the person signs out of the tab, it is not read back and is forgotten", () => {
    signedIn();
    saveToken(PK, TOKEN);
    expect(readToken(PK)).toBe(TOKEN);

    window.sessionStorage.removeItem(SESSION_KEY);
    expect(readToken(PK)).toBeNull();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();

    // Someone else signed in to the tab since.
    signedIn(OTHER_PK);
    saveToken(PK, TOKEN);
    expect(readToken(PK)).toBeNull();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("is forgotten by forgetToken, for signing out", () => {
    signedIn();
    saveToken(PK, TOKEN);
    forgetToken();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(readToken(PK)).toBeNull();
  });

  it("is kept nowhere when storage is blocked, and nothing throws", () => {
    signedIn();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    expect(() => saveToken(PK, TOKEN)).not.toThrow();
    expect(readToken(PK)).toBeNull();
    expect(() => forgetToken()).not.toThrow();
  });
});

describe("latestRun", () => {
  it("reads the person's latest run, keeping only what the app needs (not the run's password)", async () => {
    server.routes["GET /user/graperankResult"] = () => json(200, { code: 200, message: null, data: wireRun() });

    const run = await latestRun(TOKEN, never());

    expect(run).toEqual({
      status: "ongoing",
      internalPublicationStatus: "waiting",
      taStatus: "waiting",
      countValues: "",
      othersFirst: 3,
      createdAt: Date.UTC(2026, 9, 8, 11, 40, 0, 123),
      updatedAt: Date.UTC(2026, 9, 8, 11, 52, 30),
    } satisfies Run);
    expect(JSON.stringify(run)).not.toContain("the-run-password");
  });

  it("reads Brainstorm's times as UTC, written with no zone, or with one", async () => {
    const cases: Array<[string, number]> = [
      ["2026-10-08T11:40:00", Date.UTC(2026, 9, 8, 11, 40)],
      ["2026-10-08T11:40:00.5", Date.UTC(2026, 9, 8, 11, 40, 0, 500)],
      ["2026-10-08T11:40:00.999999", Date.UTC(2026, 9, 8, 11, 40, 0, 999)],
      ["2026-10-08T11:40:00Z", Date.UTC(2026, 9, 8, 11, 40)],
      ["2026-10-08T11:40:00+00:00", Date.UTC(2026, 9, 8, 11, 40)],
      ["2026-10-08T13:40:00+02:00", Date.UTC(2026, 9, 8, 11, 40)],
    ];
    for (const [written, ms] of cases) {
      server.routes["GET /user/graperankResult"] = () => json(200, { data: wireRun({ created_at: written }) });
      expect((await latestRun(TOKEN, never()))?.createdAt, written).toBe(ms);
    }
  });

  it("is null when the person has no run yet", async () => {
    server.routes["GET /user/graperankResult"] = () => json(200, { code: 200, message: null, data: null });
    await expect(latestRun(TOKEN, never())).resolves.toBeNull();
  });

  it("reads a status it does not know, or none, as no status", async () => {
    server.routes["GET /user/graperankResult"] = () =>
      json(200, { data: wireRun({ status: "cancelled", ta_status: null, internal_publication_status: 7 }) });
    const run = await latestRun(TOKEN, never());
    expect(run).toMatchObject({ status: null, taStatus: null, internalPublicationStatus: null });
  });

  it("says the token has expired on a 401", async () => {
    server.routes["GET /user/graperankResult"] = () => json(401, { detail: "Your token has expired" });
    await expect(latestRun(TOKEN, never())).rejects.toBeInstanceOf(TokenExpired);
  });

  it("is unavailable on a 500, a network error (a 500 without CORS looks like one), or a run it cannot read", async () => {
    const failures: Route[] = [
      () => json(500, { detail: "Internal Server Error" }),
      () => "network error",
      () => json(200, { data: { status: "ongoing" } }),
      () => json(200, { data: wireRun({ created_at: "yesterday" }) }),
      () => json(200, { nothing: true }),
      () => json(404, { detail: "Not Found" }),
    ];
    for (const failure of failures) {
      server.routes["GET /user/graperankResult"] = failure;
      await expect(latestRun(TOKEN, never())).rejects.toBeInstanceOf(Unavailable);
    }
  });
});

describe("startRun", () => {
  it("starts a run and gives it back", async () => {
    server.routes["POST /user/graperank"] = () => json(200, { code: 200, message: null, data: wireRun({ status: "waiting" }) });
    const started = await startRun(TOKEN, never());
    expect(started).toEqual({ run: expect.objectContaining({ status: "waiting" }) });
  });

  it("says the circle was worked out recently on 429 (per address), 429 (quota) and 403 (too recent)", async () => {
    const answers = [
      json(429, { detail: "Too many requests" }),
      json(429, { detail: "Manual recalculation quota reached for Free: 20 per 7 days. Resets at 2026-10-12 08:00 UTC." }),
      json(403, { detail: "The last triggered Graperank was too recent" }),
    ];
    for (const answer of answers) {
      server.routes["POST /user/graperank"] = () => answer;
      await expect(startRun(TOKEN, never())).resolves.toEqual({ recently: true });
    }
  });

  it("says the token has expired on a 401", async () => {
    server.routes["POST /user/graperank"] = () => json(401, { detail: "Bad token" });
    await expect(startRun(TOKEN, never())).rejects.toBeInstanceOf(TokenExpired);
  });

  it("is unavailable on a 500, a network error, a timeout or a run it cannot read", async () => {
    const failures: Route[] = [
      () => json(500, { detail: "Internal Server Error" }),
      () => "network error",
      () => json(200, { data: null }),
      () => json(200, "ok"),
    ];
    for (const failure of failures) {
      server.routes["POST /user/graperank"] = failure;
      await expect(startRun(TOKEN, never())).rejects.toBeInstanceOf(Unavailable);
    }
    server.routes["POST /user/graperank"] = () => "never";
    const outcome = startRun(TOKEN, never()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(await outcome).toBeInstanceOf(Unavailable);
  });
});

describe("an answer it does not read", () => {
  /** An answer of `status` whose body notes when it is cancelled. */
  function unread(status: number) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"detail":"unread"}'));
      },
      cancel,
    });
    return { answer: new Response(body, { status, headers: { "content-type": "application/json" } }), cancel };
  }

  it("has its body cancelled, so the browser can let the connection go", async () => {
    const cases: Array<[string, number, () => Promise<unknown>]> = [
      ["GET /authChallenge/:pk", 502, () => signInToBrainstorm(PK, signerOf(), never())],
      ["POST /authChallenge/:pk/verify", 400, () => signInToBrainstorm(PK, signerOf(), never())],
      ["GET /user/graperankResult", 401, () => latestRun(TOKEN, never())],
      ["GET /user/graperankResult", 500, () => latestRun(TOKEN, never())],
      ["POST /user/graperank", 429, () => startRun(TOKEN, never())],
      ["POST /user/graperank", 403, () => startRun(TOKEN, never())],
      ["GET /setup/:pk", 500, () => scorerOf(PK, never())],
    ];
    for (const [route, status, call] of cases) {
      server = brainstorm();
      vi.stubGlobal("fetch", server.fetch);
      const { answer, cancel } = unread(status);
      server.routes[route] = () => answer;
      await call().catch(() => {});
      await vi.waitFor(() => expect(cancel, `${route} ${status}`).toHaveBeenCalled());
    }
  });
});

describe("runState", () => {
  const run = (status: RunStatus | null, internal: RunStatus | null, ta: RunStatus | null): Run => ({
    status,
    internalPublicationStatus: internal,
    taStatus: ta,
    countValues: null,
    othersFirst: 0,
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  });

  it("reads the runs Brainstorm goes through", () => {
    expect(runState(run("waiting", "waiting", "waiting"))).toBe("waiting");
    expect(runState(run("ongoing", "waiting", "waiting"))).toBe("running");
    expect(runState(run("success", "ongoing", "waiting"))).toBe("running");
    expect(runState(run("success", "success", "ongoing"))).toBe("running");
    expect(runState(run("success", "success", "success"))).toBe("done");
    expect(runState(run("failure", "waiting", "waiting"))).toBe("failed");
    expect(runState(run("success", "success", "failure"))).toBe("failed");
    expect(runState(run("success", "failure", "waiting"))).toBe("failed");
  });

  it("gives every combination of the three statuses its state", () => {
    const statuses: Array<RunStatus | null> = ["waiting", "ongoing", "success", "failure", null];
    let combinations = 0;
    for (const status of statuses) {
      for (const internal of statuses) {
        for (const ta of statuses) {
          combinations += 1;
          const all = [status, internal, ta];
          // The plan's rules, in its order: done when both publications succeeded; failed when any
          // of the three failed; running when any is under way; waiting otherwise.
          const expected =
            internal === "success" && ta === "success"
              ? "done"
              : all.includes("failure")
                ? "failed"
                : all.includes("ongoing")
                  ? "running"
                  : "waiting";
          expect(runState(run(status, internal, ta)), `${status} ${internal} ${ta}`).toBe(expected);
        }
      }
    }
    expect(combinations).toBe(125);
  });
});

describe("scorerOf", () => {
  /** What `/setup/{pubkey}` sends: a bare list of rows, not wrapped in `data` (setup/router.py). */
  const rows = (rank: unknown[] = ["30382:rank", SCORER, "wss://scores.brainstorm.world"]) => [
    rank,
    ["30382:followers", SCORER, "wss://scores.brainstorm.world"],
    ["30382:reporters", SCORER, "wss://scores.brainstorm.world"],
    ["30382:muters", SCORER, "wss://scores.brainstorm.world"],
    ["30382:hops", SCORER, "wss://scores.brainstorm.world"],
    ["30392", SCORER, "wss://scores.brainstorm.world"],
  ];

  it("finds the person's scorer and its relay from the rank row, with no token", async () => {
    server.routes["GET /setup/:pk"] = () => json(200, rows());
    await expect(scorerOf(PK, never())).resolves.toEqual({ pubkey: SCORER, relay: "wss://scores.brainstorm.world" });
    expect(server.asked[0]!.headers).toEqual({});
  });

  it("is null for a person Brainstorm has no scorer for: its 404 with no detail (handle_no_data)", async () => {
    server.routes["GET /setup/:pk"] = () => json(404, { detail: null });
    await expect(scorerOf(PK, never())).resolves.toBeNull();
  });

  it("is unavailable on any other 404, such as an unknown route's: that is not Brainstorm saying none", async () => {
    const answers: Route[] = [
      () => json(404, { detail: "Not Found" }),
      () => json(404, {}),
      () => json(404, null),
      () => json(404, "Not Found"),
      () => new Response("<html>Not Found</html>", { status: 404 }),
    ];
    for (const answer of answers) {
      server.routes["GET /setup/:pk"] = answer;
      await expect(scorerOf(PK, never())).rejects.toBeInstanceOf(Unavailable);
    }
  });

  it("is unavailable when the list has no rank row it can use: none, or one naming a key or relay that is not one to read", async () => {
    const bad: unknown[][] = [
      ["30382:followers", SCORER, "wss://scores.brainstorm.world"],
      ["30382:rank", SCORER.toUpperCase(), "wss://scores.brainstorm.world"],
      ["30382:rank", "abc", "wss://scores.brainstorm.world"],
      ["30382:rank", SCORER, "ws://scores.brainstorm.world"],
      ["30382:rank", SCORER, "wss://localhost:7777"],
      ["30382:rank", SCORER, "https://scores.brainstorm.world"],
      ["30382:rank", SCORER],
      ["30382:rank", SCORER, 7],
    ];
    for (const row of bad) {
      server.routes["GET /setup/:pk"] = () => json(200, [row]);
      await expect(scorerOf(PK, never()), JSON.stringify(row)).rejects.toBeInstanceOf(Unavailable);
    }
    server.routes["GET /setup/:pk"] = () => json(200, []);
    await expect(scorerOf(PK, never())).rejects.toBeInstanceOf(Unavailable);
  });

  it("writes the relay one way", async () => {
    server.routes["GET /setup/:pk"] = () => json(200, rows(["30382:rank", SCORER, "WSS://Scores.Brainstorm.World/"]));
    await expect(scorerOf(PK, never())).resolves.toEqual({ pubkey: SCORER, relay: "wss://scores.brainstorm.world" });
  });

  it("is unavailable on a 500, a network error, or an answer that is not a list", async () => {
    const failures: Route[] = [
      () => json(500, { detail: "Internal Server Error" }),
      () => "network error",
      () => json(200, { data: rows() }),
      () => new Response("not json", { status: 200 }),
    ];
    for (const failure of failures) {
      server.routes["GET /setup/:pk"] = failure;
      await expect(scorerOf(PK, never())).rejects.toBeInstanceOf(Unavailable);
    }
  });

  it("refuses a public key that is not one, asking nothing", async () => {
    await expect(scorerOf("x/../user/self", never())).rejects.toBeInstanceOf(TypeError);
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe("one sign-in at a time, across tabs (Review Focus 2)", () => {
  /** What Brainstorm was asked, in order, as `METHOD path`. */
  const order = () => server.asked.map((req) => `${req.method} ${new URL(req.url).pathname.replace(PK, "pk")}`);

  /** Two tabs, each tapping Personalize at once, each with a signer that takes a second to sign. */
  async function twoTaps() {
    const first = await openTab();
    const second = await openTab();
    const one = first.signInToBrainstorm(PK, signerOf(KEY, 1_000), never());
    const two = second.signInToBrainstorm(PK, signerOf(KEY, 1_000), never());
    const outcomes = Promise.allSettled([one, two]);
    await vi.advanceTimersByTimeAsync(10_000);
    return outcomes;
  }

  const SEQUENTIAL = [
    "GET /authChallenge/pk",
    "POST /authChallenge/pk/verify",
    "GET /authChallenge/pk",
    "POST /authChallenge/pk/verify",
  ];

  it("takes the browser's sign-in lock, so a second tab waits for the first, and both sign in", async () => {
    const outcomes = await twoTaps();

    expect(locks.requests).toEqual([SIGN_IN_LOCK, SIGN_IN_LOCK]);
    expect(SIGN_IN_LOCK).toBe("regulars.brainstorm.signin");
    expect(order()).toEqual(SEQUENTIAL);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: tokenNumber(1) },
      { status: "fulfilled", value: tokenNumber(2) },
    ]);
  });

  it("does not wait for ever on a lock another tab never lets go: after a while it signs in anyway", async () => {
    // Another tab holds the lock and never lets go.
    void locks.request(SIGN_IN_LOCK, {}, () => new Promise<never>(() => {}));

    const outcome = signInToBrainstorm(PK, signerOf(), never()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS - 1);
    expect(server.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(tokenNumber(1));
  });

  it("stops waiting for the lock when the signal aborts, asking nothing", async () => {
    void locks.request(SIGN_IN_LOCK, {}, () => new Promise<never>(() => {}));
    const stop = new AbortController();
    const outcome = signInToBrainstorm(PK, signerOf(), stop.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("Gone");
    stop.abort(reason);
    expect(await outcome).toBe(reason);
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("lets go of the lock when a sign-in fails, so the next tab can sign in", async () => {
    const first = await openTab();
    const second = await openTab();
    const no = first.signInToBrainstorm(PK, { ...signerOf(), signEvent: () => Promise.reject(new Error("No")) }, never());
    const yes = second.signInToBrainstorm(PK, signerOf(), never());
    const outcomes = Promise.allSettled([no, yes]);
    await vi.advanceTimersByTimeAsync(10);
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("goes ahead at once, unguarded, in a browser with no Web Locks", async () => {
    // Every browser the app supports has them; they need a secure context, which the app needs anyway.
    useLocks(undefined);
    const channels = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          channels();
        }
      },
    );

    const signing = signInToBrainstorm(PK, signerOf(), never());
    await vi.advanceTimersByTimeAsync(0);
    expect(order()).toEqual(SEQUENTIAL.slice(0, 2));
    await expect(signing).resolves.toBe(tokenNumber(1));
    expect(channels).not.toHaveBeenCalled();
  });
});
