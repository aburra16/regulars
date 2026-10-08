import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { ForgetOnSignOut } from "../account/forgetOnSignOut.ts";
import { readSession } from "../account/session.ts";
import { publicRelayAddress } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { type RelayReader, readAll } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { usePlaces } from "../places/store.tsx";
import { useRelays } from "../score/ScoresProvider.tsx";
import { RANK_KIND, ranksFrom, type Scorer } from "../trust/houseWeights.ts";
import type { Run } from "./brainstorm.ts";
import { forgetToken, readToken } from "./token.ts";

/*
 * The person's circle (My circle), and knowing when it is ready (decisions 8 and 26). Brainstorm, our
 * scoring partner, works it out once the person taps Personalize: the app signs them in to Brainstorm
 * (their add-on or phone app asks them), reads or starts their GrapeRank run, and polls it until it
 * is done; then the scorer Brainstorm made for them, which publishes their circle's ranks, is named in
 * Brainstorm's setup and can be read from its relay. That scorer is what My circle's scores are read
 * from (Task 3).
 *
 * Only the tap starts this. The one thing asked of Brainstorm without it is the returning visitor's
 * look: once a session, after the places have loaded, a signed-in tab asks Brainstorm's setup (no
 * token, and it creates nothing) whether the person has a scorer, and its relay whether it has ranks.
 * If so, they personalized before, and My circle is ready at once.
 *
 * Where it is, is kept for the tab (`CIRCLE_KEY`, sessionStorage), so a reload carries on polling the
 * run under way, and starts none (Review Focus 3). Signing out forgets it, and Brainstorm's token
 * (`ForgetCircleOnSignOut`). Brainstorm's client (./brainstorm.ts) is loaded when it is first needed.
 */

/** Where the person's circle is. */
export type CircleState =
  /** Not asked for: Personalize is offered. */
  | "off"
  /** Looking whether a returning visitor's circle is ready already. */
  | "checking"
  /** The person's add-on or phone app asks them to let Brainstorm know it is them. */
  | "signing"
  /** Brainstorm is working it out: polled every 15 s, for at most 45 minutes. */
  | "working"
  /** Ready: its scorer can be read. */
  | "ready"
  /** Ready, from a run Brainstorm made lately, as it would not start another. */
  | "recently"
  /** Brainstorm would not start a run (too many from this address), and the person has none yet. */
  | "busy"
  /** The run failed. */
  | "failed"
  /** Brainstorm could not be reached, or the run took too long. */
  | "unavailable";

/** Where the circle's state is kept for the tab, with the public key of the person it is for. */
export const CIRCLE_KEY = "regulars.circle";

/** How often a run is polled (Global Constraints). */
export const POLL_MS = 15_000;

/** How often the circle is looked for without a token, once Brainstorm's has run out while polling. */
export const OPEN_POLL_MS = 60_000;

/** How long a run is polled for, from the tap, before it is given up (Global Constraints). */
export const POLL_CAP_MS = 45 * 60_000;

/**
 * How many polls in a row Brainstorm can fail to answer before the circle is said to be unavailable:
 * one that fails is a blip; three are an outage, offline, or a 500 that comes without CORS headers.
 */
export const MISSED_POLLS = 3;

/** The person's circle, and what can be done about it. */
export interface CircleValue {
  state: CircleState;
  /** Whether My circle can be shown: the state is ready or recently, and the scorer known. */
  ready: boolean;
  /** Who publishes the person's circle's ranks, and where: known once it is ready. */
  scorer?: Scorer;
  /** Whether the quiet notice that it is ready ("ready" or "recently") is to be shown. */
  notice: boolean;
  /** Asks Brainstorm to work out the circle: the person's tap. Only while it is off, busy, failed or unavailable. */
  personalize(): void;
  /** The same, from Try again. */
  retry(): void;
  /** Stops waiting on the add-on or the phone app, and goes back to off. */
  cancel(): void;
  /** Puts the notice away. */
  dismissReady(): void;
}

const ignore = () => {};

/** No circle: what a tree with no provider has, such as a test of part of the app. */
const NONE: CircleValue = {
  state: "off",
  ready: false,
  notice: false,
  personalize: ignore,
  retry: ignore,
  cancel: ignore,
  dismissReady: ignore,
};

/** The circle, for the parts of the app below `CircleProvider`; a test may give one of its own. */
export const CircleContext = createContext<CircleValue>(NONE);

/** The person's circle. Outside a `CircleProvider`, there is none. */
export function useCircle(): CircleValue {
  return useContext(CircleContext);
}

// ---- What the tab keeps ----

/** The states that are kept: the others last only while the page is open. */
type KeptState = Exclude<CircleState, "checking" | "signing">;

const KEPT: ReadonlySet<string> = new Set<KeptState>(["off", "working", "ready", "recently", "busy", "failed", "unavailable"]);

/** What is kept for the tab: whose circle, where it is, since when it has been worked out, and its scorer once ready. */
interface Kept {
  pubkey: string;
  state: KeptState;
  since?: number;
  scorer?: Scorer;
  notice?: boolean;
}

/** The scorer in `value`, as kept: a public key and a public `wss://` relay; undefined if it is not one. */
function asScorer(value: unknown): Scorer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { pubkey, relay } = value as Record<string, unknown>;
  const at = publicRelayAddress(relay);
  return typeof pubkey === "string" && isHex64(pubkey) && at !== null ? { pubkey, relay: at } : undefined;
}

/**
 * What this tab keeps of `pubkey`'s circle, or null: none kept, another person's, or not what this
 * module writes. Any kept record means the returning visitor's look has been done this session.
 */
function readKept(pubkey: string): Kept | null {
  let text: string | null;
  try {
    text = window.sessionStorage.getItem(CIRCLE_KEY);
  } catch {
    // Storage that is blocked keeps nothing.
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const kept = value as Record<string, unknown>;
  if (kept.pubkey !== pubkey || typeof kept.state !== "string" || !KEPT.has(kept.state)) return null;
  const state = kept.state as KeptState;
  if (state === "working") {
    return typeof kept.since === "number" && Number.isFinite(kept.since) ? { pubkey, state, since: kept.since } : null;
  }
  if (state === "ready" || state === "recently") {
    const scorer = asScorer(kept.scorer);
    return scorer === undefined ? null : { pubkey, state, scorer, notice: kept.notice === true };
  }
  return { pubkey, state };
}

/** Keeps `kept` for the tab, while the tab's session is that person's: never for someone signed out. */
function keep(kept: Kept): void {
  if (readSession()?.pubkey !== kept.pubkey) return;
  try {
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify(kept));
  } catch {
    // Blocked or full: a reload starts from the returning visitor's look.
  }
}

/** Forgets the circle this tab keeps, and Brainstorm's token: for signing out. */
export function forgetCircle(): void {
  forgetToken();
  try {
    window.sessionStorage.removeItem(CIRCLE_KEY);
  } catch {
    // Blocked: there is nothing kept to forget.
  }
}

/**
 * Lets go of the circle and Brainstorm's token at Sign out, beside what the providers around it let
 * go of (src/account/forgetOnSignOut.ts). It goes between them and the account provider.
 */
export function ForgetCircleOnSignOut({ children }: { children: ReactNode }): JSX.Element {
  const forgetTheRest = useContext(ForgetOnSignOut);
  const forget = useCallback(() => {
    forgetTheRest();
    forgetCircle();
  }, [forgetTheRest]);
  return <ForgetOnSignOut value={forget}>{children}</ForgetOnSignOut>;
}

// ---- Asking Brainstorm ----

type Client = typeof import("./brainstorm.ts");

let clientCode: Promise<Client> | undefined;

/** Brainstorm's client, loaded when it is first needed, and once. A load that fails is tried again next time. */
function loadClient(): Promise<Client> {
  clientCode ??= import("./brainstorm.ts").catch((error: unknown) => {
    clientCode = undefined;
    throw error;
  });
  return clientCode;
}

/** A flow: the look, the tap's, or polling after a reload. Each has its own number. */
interface Flow {
  id: number;
  mode: "check" | "start" | "resume";
}

let flows = 0;
const newFlow = (mode: Flow["mode"]): Flow => ({ id: ++flows, mode });

/** What the provider shows, and the flow under way. */
interface Shown {
  /** Whose circle it is: the person signed in, or the one whose session is being restored. */
  who: string | undefined;
  state: CircleState;
  scorer?: Scorer;
  notice: boolean;
  /** While working: when the tap that started it was, for the 45 minutes. */
  since?: number;
  flow: Flow | null;
}

/** Where `who`'s circle starts on this page: what the tab keeps, else the returning visitor's look. */
function shownFor(who: string | undefined): Shown {
  if (who === undefined || !config.features.circle) return { who, state: "off", notice: false, flow: null };
  const kept = readKept(who);
  if (kept === null) return { who, state: "checking", notice: false, flow: newFlow("check") };
  return {
    who,
    state: kept.state,
    scorer: kept.scorer,
    notice: kept.notice ?? false,
    since: kept.since,
    flow: kept.state === "working" ? newFlow("resume") : null,
  };
}

/** What a flow works with: whose circle, how to say where it is, when to stop, and the relays. */
interface Step {
  pubkey: string;
  set(change: Partial<Shown>): void;
  signal: AbortSignal;
  readers: (url: string) => RelayReader;
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The person's scorer, once its ranks can be read: the one Brainstorm's setup names for them (no
 * token), with its relay answering. With `ranks`, the relay must also hold a rank by it: the only
 * sign, without a run to look at, that their circle has been worked out. Without, the relay need only
 * answer: a run that is done has published what it has, which for a circle of one may be nothing.
 * Null when Brainstorm names no scorer yet, or a rank was asked for and there is none. Throws when
 * Brainstorm or the relay cannot be reached, or `step.signal` aborts.
 */
async function readableScorer(client: Client, step: Step, ranks: boolean): Promise<Scorer | null> {
  const scorer = await client.scorerOf(step.pubkey, step.signal);
  if (scorer === null) return null;
  const filter = { kinds: [RANK_KIND], authors: [scorer.pubkey], limit: 1 };
  const values = await readAll(step.readers(scorer.relay), filter, step.signal);
  return !ranks || ranksFrom(values, scorer.pubkey).size > 0 ? scorer : null;
}

/** The returning visitor's look: ready at once when they personalized before; otherwise off, quietly. */
async function check(step: Step): Promise<void> {
  try {
    const client = await loadClient();
    const scorer = await readableScorer(client, step, true);
    step.set(scorer === null ? { state: "off", flow: null } : { state: "ready", scorer, notice: false, flow: null });
  } catch {
    // Brainstorm or the relay could not be reached: Personalize is offered, and says more if tapped.
    step.set({ state: "off", flow: null });
  }
}

/**
 * Polls the person's run until their circle is ready: every 15 s with the token, from `run` when
 * given (else asked first). When Brainstorm says the token has run out, it is let go of, and the
 * person is not asked again (Global Constraints, Token): from then on the scorer and its ranks are
 * looked for every minute, with no token. A failed run is "failed"; `MISSED_POLLS` unanswered polls in
 * a row, or 45 minutes from `since`, "unavailable". Never spins for ever (Review Focus 4).
 */
async function follow(client: Client, step: Step, token: string | null, since: number, run?: Run | null): Promise<void> {
  const { signal } = step;
  let held = token;
  let current = run;
  let missed = 0;
  for (;;) {
    if (Date.now() - since >= POLL_CAP_MS) return step.set({ state: "unavailable", flow: null });
    try {
      if (held !== null) {
        const now = current === undefined ? await client.latestRun(held, signal) : current;
        const where = now === null ? "waiting" : client.runState(now);
        if (where === "failed") return step.set({ state: "failed", flow: null });
        const scorer = where === "done" ? await readableScorer(client, step, false) : null;
        if (scorer !== null) return step.set({ state: "ready", scorer, notice: true, flow: null });
      } else {
        const scorer = await readableScorer(client, step, true);
        if (scorer !== null) return step.set({ state: "ready", scorer, notice: true, flow: null });
      }
      missed = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof client.TokenExpired) {
        forgetToken();
        held = null;
        current = undefined;
        continue;
      }
      missed += 1;
      if (missed >= MISSED_POLLS) return step.set({ state: "unavailable", flow: null });
    }
    current = undefined;
    try {
      await pause(held === null ? OPEN_POLL_MS : POLL_MS, signal);
    } catch {
      return;
    }
  }
}

/**
 * The tap: the person's sign-in to Brainstorm (the one this tab has, else their add-on or phone app is
 * asked), then their latest run. A run under way is followed, and a done one is used if its scorer can
 * be read (brief § 6); with none, or a failed one, a run is started. When Brainstorm will not start
 * one (429, 403), the latest is used ("recently"), or, with none at all, Brainstorm is "busy". A
 * sign-in this tab had that has run out is let go of, and the person asked once more: they tapped.
 * The add-on or the person not going on is back to off, quietly; Brainstorm not answering is
 * "unavailable".
 */
async function start(step: Step, account: Account): Promise<void> {
  const { pubkey, signal } = step;
  let client: Client;
  try {
    client = await loadClient();
  } catch {
    return step.set({ state: "unavailable", flow: null });
  }

  let token = readToken(pubkey);
  let asked = false;
  let since = Date.now();
  let latest: Run | null;
  for (;;) {
    if (token === null) {
      asked = true;
      step.set({ state: "signing" });
      try {
        token = await client.signInToBrainstorm(pubkey, account.signer, signal, { how: account.how });
      } catch (error) {
        if (signal.aborted) return;
        const unreachable = error instanceof client.Unavailable || error instanceof client.SignInRefused;
        return step.set({ state: unreachable ? "unavailable" : "off", flow: null });
      }
    }
    since = Date.now();
    step.set({ state: "working", since });
    try {
      latest = await client.latestRun(token, signal);
      break;
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof client.TokenExpired)) return step.set({ state: "unavailable", flow: null });
      forgetToken();
      token = null;
      // A sign-in made just now that is refused is Brainstorm's trouble, not the person's: no second ask.
      if (asked) return step.set({ state: "unavailable", flow: null });
    }
  }

  let run = latest;
  let recently = false;
  try {
    const where = run === null ? null : client.runState(run);
    if (where === null || where === "failed") {
      const started = await client.startRun(token, signal);
      if ("run" in started) {
        run = started.run;
      } else {
        recently = true;
        run = await client.latestRun(token, signal);
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof client.TokenExpired) forgetToken();
    return step.set({ state: "unavailable", flow: null });
  }
  if (run === null) return step.set({ state: "busy", flow: null });
  if (recently && client.runState(run) === "done") {
    try {
      const scorer = await readableScorer(client, step, false);
      if (scorer !== null) return step.set({ state: "recently", scorer, notice: true, flow: null });
    } catch {
      if (signal.aborted) return;
      // Not readable yet: followed below, as any done run.
    }
  }
  await follow(client, step, token, since, run);
}

/** A reload while the circle was being worked out: polling carries on, starting no run (Review Focus 3). */
async function resume(step: Step, since: number): Promise<void> {
  let client: Client;
  try {
    client = await loadClient();
  } catch {
    return step.set({ state: "unavailable", flow: null });
  }
  await follow(client, step, readToken(step.pubkey), since);
}

/** The states in which Personalize, or Try again, can be tapped. */
const CAN_START: ReadonlySet<CircleState> = new Set<CircleState>(["off", "busy", "failed", "unavailable"]);

/**
 * Holds the person's circle for the parts of the app below it (`useCircle`): the toggle, the view and
 * Personalize. It must be inside the account provider, the scores provider (whose readers read the
 * scorer's relay) and the places provider (the returning visitor's look waits for the places). Nothing
 * happens while My circle is closed (`config.features.circle`), or nobody is signed in.
 */
export function CircleProvider({ children }: { children: ReactNode }): JSX.Element {
  const { account, restoring } = useAccount();
  const { readers } = useRelays();
  const placesIn = usePlaces().places.length > 0;
  const who = account?.pubkey ?? (restoring ? readSession()?.pubkey : undefined);
  const [shown, setShown] = useState(() => shownFor(who));
  // Someone signed in, out, or someone else: their circle, from what the tab keeps of it.
  if (shown.who !== who) setShown(shownFor(who));

  // The account the tap was made with, whose signer asks the person.
  const tappedWith = useRef<Account | undefined>(undefined);

  /** A flow's step: what it sets is taken only while it is the flow under way, for the same person. */
  const stepFor = useCallback(
    (pubkey: string, id: number, signal: AbortSignal): Step => ({
      pubkey,
      signal,
      readers,
      set(change) {
        if (signal.aborted) return;
        setShown((now) => (now.who === pubkey && now.flow?.id === id ? { ...now, ...change } : now));
      },
    }),
    [readers],
  );

  // The returning visitor's look, once the places have loaded and the person is signed in.
  const looking = shown.flow?.mode === "check" ? shown.flow : null;
  const signedIn = account !== undefined;
  useEffect(() => {
    if (looking === null || shown.who === undefined || !placesIn || !signedIn) return;
    const stop = new AbortController();
    void check(stepFor(shown.who, looking.id, stop.signal));
    return () => stop.abort();
  }, [looking, shown.who, placesIn, signedIn, stepFor]);

  // The tap's flow, or polling after a reload.
  const working = shown.flow !== null && shown.flow.mode !== "check" ? shown.flow : null;
  useEffect(() => {
    if (working === null || shown.who === undefined) return;
    const stop = new AbortController();
    const step = stepFor(shown.who, working.id, stop.signal);
    if (working.mode === "resume") {
      void resume(step, shown.since ?? Date.now());
    } else {
      const tapped = tappedWith.current;
      if (tapped?.pubkey === shown.who) void start(step, tapped);
      else step.set({ state: "off", flow: null });
    }
    return () => stop.abort();
    // `since` is read as the flow starts: the flow setting it after starts no other.
  }, [working, shown.who, stepFor]);

  // Kept for the tab, as it changes.
  useEffect(() => {
    const { who: pubkey, state, since, scorer, notice } = shown;
    if (pubkey === undefined || !config.features.circle || state === "checking" || state === "signing") return;
    if (state === "working") keep({ pubkey, state, since });
    else if ((state === "ready" || state === "recently") && scorer !== undefined) keep({ pubkey, state, scorer, notice });
    else keep({ pubkey, state });
  }, [shown]);

  // The latest of what is shown, for the taps.
  const latest = useRef(shown);
  useLayoutEffect(() => {
    latest.current = shown;
  });

  const personalize = useCallback(() => {
    const now = latest.current;
    if (!config.features.circle || account === undefined || now.who !== account.pubkey || !CAN_START.has(now.state)) return;
    tappedWith.current = account;
    // With a sign-in this tab already has, the add-on is not asked.
    const state: CircleState = readToken(account.pubkey) === null ? "signing" : "working";
    const flow = newFlow("start");
    const since = Date.now();
    setShown((current) =>
      current.who === account.pubkey && CAN_START.has(current.state)
        ? { ...current, state, since, notice: false, flow }
        : current,
    );
  }, [account]);

  const cancel = useCallback(() => {
    setShown((now) => (now.state === "signing" ? { ...now, state: "off", flow: null } : now));
  }, []);

  const dismissReady = useCallback(() => {
    setShown((now) => (now.notice ? { ...now, state: now.state === "recently" ? "ready" : now.state, notice: false } : now));
  }, []);

  const ready = (shown.state === "ready" || shown.state === "recently") && shown.scorer !== undefined;
  const value = useMemo<CircleValue>(
    () => ({
      state: shown.state,
      ready,
      scorer: ready ? shown.scorer : undefined,
      notice: ready && shown.notice,
      personalize,
      retry: personalize,
      cancel,
      dismissReady,
    }),
    [shown.state, shown.scorer, shown.notice, ready, personalize, cancel, dismissReady],
  );
  return <CircleContext value={value}>{children}</CircleContext>;
}
