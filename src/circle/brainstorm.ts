import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

import type { How } from "../account/session.ts";
import { abortable, publicRelayAddress } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { isToken, saveToken } from "./token.ts";

/*
 * Talking to Brainstorm (`config.brainstormApi`), which works out a person's circle: signing its
 * login and trading it for a token, reading and starting the person's GrapeRank run, and finding
 * the scorer that publishes their circle's ranks. Its sign-in sets up the person's public scoring
 * profile, so it is asked only when the person taps Personalize (Global Constraints): this module
 * asks nothing, takes no lock and opens no channel until one of its functions is called. It is
 * loaded only when it is first needed. Plain `fetch`, sending no cookies. Nothing here is logged:
 * the token and the signed login are the person's.
 *
 * Answers as brainstorm_server dc8c4f3 gives them (app/routers/auth_challenge, user, setup):
 * `{ code, message, data }`, but for `/setup/{pubkey}`, a bare list; an error, `{ detail }`, which
 * this reads only by its status.
 */

/** The kind of Brainstorm's login event. */
export const LOGIN_KIND = 22242;

/** How long Brainstorm has to answer one request. Then it is unavailable. */
export const ANSWER_WAIT_MS = 20_000;

/**
 * How long the person's signer has to sign the login: an add-on as long as for a review
 * (`SIGN_TIMEOUT_MS`, src/review/post.ts), a phone app as long as for any request
 * (`REQUEST_TIMEOUT_MS`, src/account/connect.ts), since the person may have to find their phone.
 */
export const SIGN_WAIT_MS: Readonly<Record<How, number>> = { browser: 60_000, phone: 120_000 };

/**
 * The browser's lock (Web Locks) that one sign-in holds, in whichever tab: Brainstorm keeps one
 * challenge per person, the newest replacing the last, so two at once would break the first.
 */
export const SIGN_IN_LOCK = "regulars.brainstorm.signin";

/**
 * How long a sign-in waits for the lock: longer than one sign-in can take (two answers and the
 * slowest signer), so it waits out the one that holds it. A tab that holds it longer is stuck, and
 * the sign-in goes ahead without it: no wait goes on for ever.
 *
 * The wait counts from the request, not from when the tab ahead got the lock. So with three tabs
 * waiting in turn, the third can go ahead when its time is up while the second, which got the lock
 * late, still holds it, and their challenges cross. That takes three taps at once and slow signing,
 * and is the price of never waiting for ever.
 */
export const LOCK_WAIT_MS = 2 * ANSWER_WAIT_MS + SIGN_WAIT_MS.phone + 20_000;

/** Where a run is: each of its three parts is one of these. */
export type RunStatus = "waiting" | "ongoing" | "success" | "failure";

/** Where the person's circle is, from their run (`runState`). */
export type RunState = "waiting" | "running" | "done" | "failed";

/**
 * A GrapeRank run of the person's (Brainstorm's BrainstormRequestInstance), as much as the app
 * needs: not its password, parameters or ids. A status that is missing, or one this does not know,
 * is null.
 */
export interface Run {
  /** `status`: working out the ranks. */
  status: RunStatus | null;
  /** `internal_publication_status`: saving them where Brainstorm reads them. */
  internalPublicationStatus: RunStatus | null;
  /** `ta_status`: publishing them to the relay, signed by the person's scorer (kind 30382). */
  taStatus: RunStatus | null;
  /** `count_values`: how many people the run found, as Brainstorm writes it (JSON, or empty while it runs). */
  countValues: string | null;
  /** `how_many_others_with_priority`: how many runs go before this one. */
  othersFirst: number;
  /** `created_at` and `updated_at`, in milliseconds since 1970 (Brainstorm writes UTC with no zone). */
  createdAt: number;
  updatedAt: number;
}

/**
 * Brainstorm could not be reached (offline, or a refusal the browser hides: a 500 comes without
 * CORS headers, and reads as a network error), did not answer in time, failed (5xx), or answered
 * with something this cannot read. `status` is its status, when it answered.
 */
export class Unavailable extends Error {
  constructor(readonly status?: number) {
    super(status === undefined ? "Brainstorm could not be reached" : `Brainstorm answered ${status}`);
    this.name = "Unavailable";
  }
}

/**
 * Brainstorm refused the token (401): it has expired, after about an hour, or is not one. The person
 * signs its login again only when they act (Global Constraints, Token).
 */
export class TokenExpired extends Error {
  constructor() {
    super("Brainstorm's token has expired");
    this.name = "TokenExpired";
  }
}

/**
 * Brainstorm refused the signed login: it had no challenge for the person (400: it expired, or
 * another sign-in replaced it), or found the event invalid (401).
 */
export class SignInRefused extends Error {
  constructor(readonly status: number) {
    super(`Brainstorm refused the login (${status})`);
    this.name = "SignInRefused";
  }
}

/** The signer did not sign the login in time, or signed something other than it. */
export class NotSigned extends Error {
  constructor() {
    super("The login was not signed");
    this.name = "NotSigned";
  }
}

/**
 * What Brainstorm answered: its status, and its body as JSON when the status is a success, or the
 * one error the ask said to read (`readError`); undefined otherwise.
 */
interface Answer {
  status: number;
  body: unknown;
}

/**
 * Asks Brainstorm `path`, with the token when given (`Authorization: Bearer`) and `json` as the body
 * when given. Sends no cookies and keeps nothing in the HTTP cache. The body of an error is read when
 * its status is `readError`, and otherwise cancelled unread, so that the browser can let the connection go.
 * Throws `Unavailable` when Brainstorm cannot be reached, does not answer within `ANSWER_WAIT_MS`,
 * or sends a body to read that is not JSON; the signal's reason when `signal` aborts.
 */
async function ask(
  path: string,
  how: { method: "GET" | "POST"; token?: string; json?: unknown; readError?: number },
  signal: AbortSignal,
): Promise<Answer> {
  signal.throwIfAborted();
  const headers: Record<string, string> = {};
  if (how.token !== undefined) headers.Authorization = `Bearer ${how.token}`;
  if (how.json !== undefined) headers["Content-Type"] = "application/json";
  const clock = new AbortController();
  const timer = setTimeout(
    () => clock.abort(new DOMException("Brainstorm did not answer in time", "TimeoutError")),
    ANSWER_WAIT_MS,
  );
  try {
    const response = await fetch(`${config.brainstormApi.replace(/\/+$/, "")}${path}`, {
      method: how.method,
      headers,
      body: how.json === undefined ? undefined : JSON.stringify(how.json),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.any([signal, clock.signal]),
    });
    if (!response.ok && response.status !== how.readError) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status, body: undefined };
    }
    return { status: response.status, body: await response.json() };
  } catch {
    signal.throwIfAborted();
    throw new Unavailable();
  } finally {
    clearTimeout(timer);
  }
}

/** The field `name` of `value`, when it is a JSON object; undefined otherwise. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** A challenge as Brainstorm makes one: hex (32 digits, from `secrets.token_hex(16)`). */
const CHALLENGE = /^[0-9a-f]{16,256}$/;

/** A new challenge for `pubkey` to sign, in place of any Brainstorm kept for them. */
async function challengeFor(pubkey: string, signal: AbortSignal): Promise<string> {
  const { status, body } = await ask(`/authChallenge/${pubkey}`, { method: "GET" }, signal);
  const challenge = status === 200 ? field(field(body, "data"), "challenge") : undefined;
  if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) throw new Unavailable(status);
  return challenge;
}

/** Whether `tags` begin with `asked`, in order: a signer may add its own after them (src/review/post.ts, ruling R15). */
function beginsWith(tags: readonly string[][], asked: readonly string[][]): boolean {
  return asked.every((tag, i) => {
    const signed = tags[i];
    return signed !== undefined && signed.length === tag.length && signed.every((value, j) => value === tag[j]);
  });
}

/**
 * Brainstorm's login for `challenge`, signed by `signer` within `within` milliseconds: the event as
 * it is signed, its seven fields only. Throws `NotSigned` when the signer does not sign in time, or
 * signs something else (another person, kind, words or tags); whatever the signer throws, as it is
 * (the person said no, or `AccountChanged`); the signal's reason when `signal` aborts.
 */
async function signLogin(
  pubkey: string,
  challenge: string,
  signer: NostrSigner,
  signal: AbortSignal,
  within: number,
): Promise<NostrEvent> {
  const tags = [
    ["t", "brainstorm_login"],
    ["challenge", challenge],
  ];
  const template = { kind: LOGIN_KIND, created_at: Math.floor(Date.now() / 1000), content: "" };
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DOMException("The signer did not answer in time", "TimeoutError")), within);
  let signed: unknown;
  try {
    signed = await abortable(
      // The signer gets its own copy of the tags, so what it does to them changes nothing asked.
      Promise.resolve().then(() => signer.signEvent({ ...template, tags: tags.map((tag) => [...tag]) })),
      AbortSignal.any([signal, clock.signal]),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (clock.signal.aborted) throw new NotSigned();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const event = asEvent(signed);
  if (
    event === null ||
    event.pubkey !== pubkey ||
    event.kind !== LOGIN_KIND ||
    event.content !== template.content ||
    !beginsWith(event.tags, tags)
  ) {
    throw new NotSigned();
  }
  return event;
}

/** The token Brainstorm gives for `login`, `pubkey`'s signed login. It sets up their scoring profile. */
async function tokenFor(pubkey: string, login: NostrEvent, signal: AbortSignal): Promise<string> {
  const { status, body } = await ask(
    `/authChallenge/${pubkey}/verify`,
    { method: "POST", json: { signed_event: login } },
    signal,
  );
  if (status === 400 || status === 401) throw new SignInRefused(status);
  const token = status === 200 ? field(field(body, "data"), "token") : undefined;
  if (!isToken(token)) throw new Unavailable(status);
  return token;
}

/**
 * Runs `task` while holding the sign-in lock (`SIGN_IN_LOCK`), so that one sign-in happens at a time
 * across the person's tabs. It waits for the lock at most `LOCK_WAIT_MS`, or until the browser will
 * not lend it, then goes ahead without it. Rejects with the signal's reason when `signal` aborts first.
 */
async function oneAtATime<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  // Every browser the app supports has Web Locks. They are only there in a secure context, which the
  // app needs anyway (Nostrify's crypto.randomUUID is only there too). Where they are missing all
  // the same, the sign-in goes ahead unguarded: two at once in two tabs may then cross challenges,
  // and the first fails as `SignInRefused`, for the person to try again.
  if (typeof locks?.request !== "function") return task();
  const wait = new AbortController();
  const timer = setTimeout(
    () => wait.abort(new DOMException("Another tab held the sign-in too long", "TimeoutError")),
    LOCK_WAIT_MS,
  );
  let granted = false;
  try {
    return await locks.request(SIGN_IN_LOCK, { signal: AbortSignal.any([signal, wait.signal]) }, () => {
      granted = true;
      clearTimeout(timer);
      return task();
    });
  } catch (error) {
    if (granted) throw error;
    signal.throwIfAborted();
    // Another tab held the lock too long, or the browser would not lend it: no wait goes on for ever.
    return task();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Signs `pubkey` in to Brainstorm, with `signer` (the person's add-on or phone app, which may ask
 * them first), and gives back the token, which it keeps for this tab (src/circle/token.ts). Call it
 * only when the person taps Personalize: it sets up their public scoring profile. One sign-in at a
 * time, across the person's tabs (`SIGN_IN_LOCK`): a second waits for the first, then signs in with a
 * challenge of its own. The signer has `SIGN_WAIT_MS[opts.how]` to sign; a phone app's time when
 * `how` is not given.
 *
 * Throws `NotSigned`, `SignInRefused` or `Unavailable` (see each); whatever the signer throws, as it
 * is; a TypeError, asking nothing, for a public key that is not one; and the signal's reason when
 * `signal` aborts.
 */
export async function signInToBrainstorm(
  pubkey: string,
  signer: NostrSigner,
  signal: AbortSignal,
  opts: { how?: How } = {},
): Promise<string> {
  signal.throwIfAborted();
  if (!isHex64(pubkey)) throw new TypeError("Not a public key");
  const within = SIGN_WAIT_MS[opts.how ?? "phone"];
  return oneAtATime(async () => {
    signal.throwIfAborted();
    const challenge = await challengeFor(pubkey, signal);
    const login = await signLogin(pubkey, challenge, signer, signal, within);
    const token = await tokenFor(pubkey, login, signal);
    saveToken(pubkey, token);
    return token;
  }, signal);
}

/** The order of the parts of a time Brainstorm writes: ISO 8601, in UTC when no zone is written. */
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/** The time `value` says, in milliseconds since 1970, read as UTC when it has no zone; null if it is not one. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = TIME.exec(value);
  if (parts === null) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone = "Z"] = parts;
  let ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.slice(0, 3).padEnd(3, "0")),
  );
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    ms -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
  }
  return Number.isFinite(ms) ? ms : null;
}

const STATUSES: ReadonlySet<string> = new Set<RunStatus>(["waiting", "ongoing", "success", "failure"]);

const statusOf = (value: unknown): RunStatus | null =>
  typeof value === "string" && STATUSES.has(value) ? (value as RunStatus) : null;

/** The run in `value`, a BrainstormRequestInstance, or null when it is not one this can read. */
function asRun(value: unknown): Run | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const wire = value as Record<string, unknown>;
  const createdAt = timeOf(wire.created_at);
  const updatedAt = timeOf(wire.updated_at);
  if (typeof wire.status !== "string" || createdAt === null || updatedAt === null) return null;
  const othersFirst = wire.how_many_others_with_priority;
  return {
    status: statusOf(wire.status),
    internalPublicationStatus: statusOf(wire.internal_publication_status),
    taStatus: statusOf(wire.ta_status),
    countValues: typeof wire.count_values === "string" ? wire.count_values : null,
    othersFirst: typeof othersFirst === "number" && Number.isSafeInteger(othersFirst) && othersFirst > 0 ? othersFirst : 0,
    createdAt,
    updatedAt,
  };
}

/**
 * The person's latest run (`GET /user/graperankResult`), or null when they have none yet. Throws
 * `TokenExpired` on a 401, `Unavailable` as `ask` does or on any other answer, and the signal's
 * reason when `signal` aborts.
 */
export async function latestRun(token: string, signal: AbortSignal): Promise<Run | null> {
  const { status, body } = await ask("/user/graperankResult", { method: "GET", token }, signal);
  if (status === 401) throw new TokenExpired();
  const data = status === 200 ? field(body, "data") : undefined;
  if (data === null) return null;
  const run = asRun(data);
  if (run === null) throw new Unavailable(status);
  return run;
}

/**
 * Starts a run of the person's (`POST /user/graperank`, no body), and gives it back. `recently` when
 * Brainstorm will not start one now: too many from this address (429), the person's quota of them
 * is used (429), or the last was too recent (403). Then the latest run is the one to use. Throws as
 * `latestRun` does.
 */
export async function startRun(token: string, signal: AbortSignal): Promise<{ run: Run } | { recently: true }> {
  const { status, body } = await ask("/user/graperank", { method: "POST", token }, signal);
  if (status === 401) throw new TokenExpired();
  if (status === 429 || status === 403) return { recently: true };
  const run = status === 200 ? asRun(field(body, "data")) : null;
  if (run === null) throw new Unavailable(status);
  return { run };
}

/**
 * Where the person's circle is. `done` once both publications have succeeded: the ranks are on the
 * relay. Else `failed` when any part failed, `running` when any is under way, and `waiting` otherwise.
 */
export function runState(run: Pick<Run, "status" | "internalPublicationStatus" | "taStatus">): RunState {
  const parts = [run.status, run.internalPublicationStatus, run.taStatus];
  if (run.internalPublicationStatus === "success" && run.taStatus === "success") return "done";
  if (parts.includes("failure")) return "failed";
  if (parts.includes("ongoing")) return "running";
  return "waiting";
}

/** The row of `/setup/{pubkey}` that names who publishes the person's ranks, and where. */
const RANK_ROW = "30382:rank";

/**
 * Whether `body`, the body of a 404, is Brainstorm saying it has nothing for the key asked:
 * `handle_no_data` raises a 404 with no detail (`{"detail": null}`). An unknown route's 404 has one
 * (`{"detail": "Not Found"}`).
 */
function isNoData(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && field(body, "detail") === null;
}

/**
 * The scorer that publishes `pubkey`'s ranks (kind 30382), and the relay it publishes them to, from
 * Brainstorm's setup (`GET /setup/{pubkey}`, no token: rows `["30382:<tag>", <scorer>, <relay>]`).
 * Null only when Brainstorm says it has none for them (its no-data 404: they have never signed in
 * to it). Throws `Unavailable` as `ask` does, and on any other answer: another 404 (such as an
 * unknown route's), or a list whose rank row is missing, or names a key that is not one or a relay
 * that is not a public `wss://` one. Throws a TypeError, asking nothing, for a public key that is
 * not one, and the signal's reason when `signal` aborts.
 */
export async function scorerOf(pubkey: string, signal: AbortSignal): Promise<{ pubkey: string; relay: string } | null> {
  signal.throwIfAborted();
  if (!isHex64(pubkey)) throw new TypeError("Not a public key");
  const { status, body } = await ask(`/setup/${pubkey}`, { method: "GET", readError: 404 }, signal);
  if (status === 404 && isNoData(body)) return null;
  const row: unknown = status === 200 && Array.isArray(body) ? body.find((entry: unknown) => Array.isArray(entry) && entry[0] === RANK_ROW) : undefined;
  const [, scorer, relay] = Array.isArray(row) ? (row as unknown[]) : [];
  const address = publicRelayAddress(relay);
  if (typeof scorer !== "string" || !isHex64(scorer) || address === null) throw new Unavailable(status);
  return { pubkey: scorer, relay: address };
}
