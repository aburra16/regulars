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
  useSyncExternalStore,
} from "react";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { ForgetOnSignOut } from "../account/forgetOnSignOut.ts";
import { readSession } from "../account/session.ts";
import { publicRelayAddress } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { type RelayReader, readAll } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { usePlaces } from "../places/store.tsx";
import { useRelays, useScoresStore } from "../score/ScoresProvider.tsx";
import { RANK_KIND, ranksFrom, type Scorer } from "../trust/houseWeights.ts";
import type { Run } from "./brainstorm.ts";
import { forgetCircleCount } from "./circleSize.ts";
import { type Client, loadBrainstorm } from "./loadBrainstorm.ts";
import { forgetToken, readToken } from "./token.ts";

/*
 * The person's circle (My circle), and knowing when it is ready (decisions 8 and 26). Brainstorm, our
 * scoring partner, works it out once the person taps Personalize: the app signs them in to Brainstorm
 * (their add-on or phone app asks them), reads or starts their GrapeRank run, and polls it until it
 * is done; then the scorer Brainstorm made for them, which publishes their circle's ranks, is named in
 * Brainstorm's setup and can be read from its relay. That scorer is what My circle's scores are read
 * from: once the circle is ready, the scores store is given it, with whose circle it is, and reads its
 * ranks beside the house's (src/score/store.ts).
 *
 * Only the tap starts this. The one thing asked of Brainstorm without it is the returning visitor's
 * look: once a session, after the places have loaded, a signed-in tab asks Brainstorm's setup (no
 * token, and it creates nothing) whether the person has a scorer, and its relay whether it has ranks.
 * If so, they personalized before, and My circle is ready at once. A scorer with no ranks is not
 * enough to say their circle was worked out (it exists from their sign-in to Brainstorm on, whether the
 * run is done, under way or failed): it is "unconfirmed", empty for now, which My circle says plainly,
 * with Work out my circle again (rulings R7, R10). That runs the tap's flow: a done run confirms it,
 * empty, for the session; one under way is followed; with a failed run, or none, one is started. A rank
 * by the scorer found later (the scores store reads them) confirms it too.
 *
 * Once the circle is ready, Update now (on the Why page) asks for it to be worked out again: the same
 * sign-in when the tab has no token, then a new run, followed while the tab is open, wherever the
 * person goes in it, as My circle keeps showing the circle they have. Once the run is done, the scores
 * store reads the new ranks (a new `edition`), and My circle shows them, wherever the person is.
 *
 * Where it is, is kept for the tab (`CIRCLE_KEY`, sessionStorage), so a reload carries on polling the
 * run under way, and starts none (Review Focus 3); an update under way is not kept, and a reload ends
 * its following, not its run. Signing out forgets it, and Brainstorm's token (`ForgetCircleOnSignOut`).
 * Brainstorm's client (./brainstorm.ts) is loaded when it is first needed (./loadBrainstorm.ts).
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
  /**
   * The returning visitor's look found a scorer with no ranks: ready to show, empty, though whether
   * its run is done, under way or failed is not known. Work out my circle again finds out (ruling R10).
   */
  | "unconfirmed"
  /** Ready, from a run Brainstorm made lately, as it would not start another. */
  | "recently"
  /** Brainstorm would not start a run (too many from this address), and the person has none yet. */
  | "busy"
  /** The run failed. */
  | "failed"
  /** Brainstorm could not be reached, or the run took too long. */
  | "unavailable";

/**
 * Where Update now is, beside the circle's state, which it leaves as it is:
 * - `idle`: not tapped, or the person did not go on with the sign-in;
 * - `signing`: their add-on or phone app asks them to approve Brainstorm's sign-in;
 * - `updating`: Brainstorm is asked, or works the circle out, followed;
 * - `started`: it works it out, and can no longer be followed (the token ran out while it did);
 * - `recently`: Brainstorm would not start a run, as one was made lately: that one is used;
 * - `updated`: worked out again, and its new ranks read;
 * - `failed`: the run failed, took too long, or Brainstorm could not be reached.
 */
export type UpdateStep = "idle" | "signing" | "updating" | "started" | "recently" | "updated" | "failed";

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
  /** Whether My circle can be shown: the state is ready, recently or unconfirmed, and the scorer known. */
  ready: boolean;
  /** Who publishes the person's circle's ranks, and where: known once it is ready. */
  scorer?: Scorer;
  /** Whether the quiet notice that it is ready ("ready" or "recently") is to be shown. */
  notice: boolean;
  /** Where Update now is. */
  updateStep: UpdateStep;
  /** Which working-out of the circle My circle's scores are from: a new one each time Update now's run is done. */
  edition: number;
  /** Asks Brainstorm to work out the circle: the person's tap. Only while it is off, unconfirmed, busy, failed or unavailable. */
  personalize(): void;
  /** The same, from Try again. */
  retry(): void;
  /**
   * Update now: asks Brainstorm to work the circle out again, the person's tap. Only while it can be
   * shown (ready, recently or unconfirmed) and nothing else is under way.
   */
  update(): void;
  /** Stops waiting on the add-on or the phone app: Personalize's, back to off; Update now's, back to idle. */
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
  updateStep: "idle",
  edition: 0,
  personalize: ignore,
  retry: ignore,
  update: ignore,
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

const KEPT: ReadonlySet<string> = new Set<KeptState>([
  "off",
  "working",
  "ready",
  "recently",
  "unconfirmed",
  "busy",
  "failed",
  "unavailable",
]);

/** What is kept for the tab: whose circle, where it is, since when its run has been followed, and its scorer once ready. */
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
  if (state === "ready" || state === "recently" || state === "unconfirmed") {
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

/** Forgets the circle this tab keeps, its count (the Why page's), and Brainstorm's token: for signing out. */
export function forgetCircle(): void {
  forgetToken();
  forgetCircleCount();
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

/** A flow: the look, the tap's, polling after a reload, or Update now's. Each has its own number. */
interface Flow {
  id: number;
  mode: "check" | "start" | "resume" | "update";
}

let flows = 0;
const newFlow = (mode: Flow["mode"]): Flow => ({ id: ++flows, mode });

/** The working-outs of circles Update now has had done: each gets its own number (`edition`). */
let editions = 0;

/** What the provider shows, and the flow under way. */
interface Shown {
  /** Whose circle it is: the person signed in, or the one whose session is being restored. */
  who: string | undefined;
  state: CircleState;
  scorer?: Scorer;
  notice: boolean;
  /**
   * While working: when the run followed was first known (Brainstorm named one, or started one, after
   * the sign-in), from which the 45 minutes count. Unset until then; and "working" is kept for the tab
   * only once it is set, so a reload before a run is known starts afresh, polling nothing.
   */
  since?: number;
  /** Where Update now is. */
  update: UpdateStep;
  /** Which working-out of the circle the scores are from: 0 until Update now's run is done. */
  edition: number;
  flow: Flow | null;
}

/** Where `who`'s circle starts on this page: what the tab keeps, else the returning visitor's look. */
function shownFor(who: string | undefined): Shown {
  const fresh = { who, notice: false, update: "idle", edition: 0 } as const;
  if (who === undefined || !config.features.circle) return { ...fresh, state: "off", flow: null };
  const kept = readKept(who);
  if (kept === null) return { ...fresh, state: "checking", flow: newFlow("check") };
  return {
    ...fresh,
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
 * token), with its relay answering; and whether the relay holds a rank by it (`ranked`): the sign,
 * without a run to look at, that their circle has been worked out and published. A scorer with none
 * may be a circle of one, or one whose run is under way or failed (ruling R10). Null when Brainstorm
 * names no scorer yet. Throws when Brainstorm or the relay cannot be reached, or `step.signal` aborts.
 */
async function findScorer(client: Client, step: Step): Promise<{ scorer: Scorer; ranked: boolean } | null> {
  const scorer = await client.scorerOf(step.pubkey, step.signal);
  if (scorer === null) return null;
  const filter = { kinds: [RANK_KIND], authors: [scorer.pubkey], limit: 1 };
  const values = await readAll(step.readers(scorer.relay), filter, step.signal);
  return { scorer, ranked: ranksFrom(values, scorer.pubkey).size > 0 };
}

/**
 * The returning visitor's look: ready at once when they personalized before and their scorer has
 * ranks; "unconfirmed" when it has none (ruling R10); otherwise off, quietly.
 */
async function check(step: Step): Promise<void> {
  try {
    const client = await loadBrainstorm();
    const found = await findScorer(client, step);
    if (found === null) return step.set({ state: "off", flow: null });
    step.set({ state: found.ranked ? "ready" : "unconfirmed", scorer: found.scorer, notice: false, flow: null });
  } catch {
    // Brainstorm or the relay could not be reached: Personalize is offered, and says more if tapped.
    step.set({ state: "off", flow: null });
  }
}

/**
 * Polls the person's run until their circle is ready: every 15 s with the token, from `run` when
 * given (else asked first). When Brainstorm says the token has run out, it is let go of, and the
 * person is not asked again (Global Constraints, Token): from then on the scorer and its ranks are
 * looked for every minute, with no token. A failed run is "failed"; no run at all (after a reload, say)
 * is back to off, quietly, for the person to tap again; `MISSED_POLLS` unanswered polls in a row, or
 * 45 minutes from `since`, "unavailable". Never spins for ever (Review Focus 4).
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
        if (now === null) return step.set({ state: "off", flow: null });
        const where = client.runState(now);
        if (where === "failed") return step.set({ state: "failed", flow: null });
        // A run that is done has published what it has, which for a circle of one may be nothing.
        const found = where === "done" ? await findScorer(client, step) : null;
        if (found !== null) return step.set({ state: "ready", scorer: found.scorer, notice: true, flow: null });
      } else {
        // With no run to look at, only a rank by the scorer says it has published.
        const found = await findScorer(client, step);
        if (found?.ranked === true) return step.set({ state: "ready", scorer: found.scorer, notice: true, flow: null });
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
    client = await loadBrainstorm();
  } catch {
    return step.set({ state: "unavailable", flow: null });
  }

  let token = readToken(pubkey);
  let asked = false;
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
    step.set({ state: "working" });
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
  // A run is known: from here a reload follows it, and the 45 minutes count.
  const since = Date.now();
  step.set({ since });
  if (recently && client.runState(run) === "done") {
    try {
      const found = await findScorer(client, step);
      if (found !== null) return step.set({ state: "recently", scorer: found.scorer, notice: true, flow: null });
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
    client = await loadBrainstorm();
  } catch {
    return step.set({ state: "unavailable", flow: null });
  }
  await follow(client, step, readToken(step.pubkey), since);
}

/**
 * Update now: has the person's circle worked out again, as My circle keeps showing the one they have.
 * The sign-in this tab has, else their add-on or phone app is asked, as for Personalize (once more if
 * the token is refused, unless the sign-in was made just now); then a new run. When Brainstorm will not
 * start one, as one was made lately (429, 403), that one is used ("recently", the brief's § 6).
 * Otherwise the run is followed, every 15 s for at most 45 minutes, while the tab is open (Global
 * Constraints); once it is done, the circle is ready, from a new working-out (`edition`), whose ranks
 * the scores store reads afresh. Never ends without a step that says so: nothing is left spinning
 * (Review Focus 4). When the token runs out while it is followed, it is "started": the person is not
 * asked again (they did not act), and the next visit reads what Brainstorm published.
 */
async function rework(step: Step, account: Account): Promise<void> {
  const { pubkey, signal } = step;
  let client: Client;
  try {
    client = await loadBrainstorm();
  } catch {
    return step.set({ update: "failed", flow: null });
  }
  let token = readToken(pubkey);
  let asked = false;
  let started: Awaited<ReturnType<Client["startRun"]>>;
  for (;;) {
    if (token === null) {
      asked = true;
      step.set({ update: "signing" });
      try {
        token = await client.signInToBrainstorm(pubkey, account.signer, signal, { how: account.how });
      } catch (error) {
        if (signal.aborted) return;
        // The person said no, or their signer did not answer: as before, quietly. Brainstorm's trouble says so.
        const unreachable = error instanceof client.Unavailable || error instanceof client.SignInRefused;
        return step.set({ update: unreachable ? "failed" : "idle", flow: null });
      }
    }
    step.set({ update: "updating" });
    try {
      started = await client.startRun(token, signal);
      break;
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof client.TokenExpired)) return step.set({ update: "failed", flow: null });
      forgetToken();
      token = null;
      // A sign-in made just now that is refused is Brainstorm's trouble, not the person's: no second ask.
      if (asked) return step.set({ update: "failed", flow: null });
    }
  }
  if ("recently" in started) return step.set({ update: "recently", flow: null });

  const since = Date.now();
  let missed = 0;
  for (;;) {
    try {
      await pause(POLL_MS, signal);
    } catch {
      return;
    }
    if (Date.now() - since >= POLL_CAP_MS) return step.set({ update: "failed", flow: null });
    try {
      const run = await client.latestRun(token, signal);
      const where = run === null ? "failed" : client.runState(run);
      if (where === "done") {
        return step.set({ update: "updated", state: "ready", notice: false, edition: ++editions, flow: null });
      }
      if (where === "failed") return step.set({ update: "failed", flow: null });
      missed = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof client.TokenExpired) {
        forgetToken();
        return step.set({ update: "started", flow: null });
      }
      missed += 1;
      if (missed >= MISSED_POLLS) return step.set({ update: "failed", flow: null });
    }
  }
}

/** The states in which the circle can be shown (with its scorer known): ready, recently or unconfirmed. */
const SHOWN: ReadonlySet<CircleState> = new Set<CircleState>(["ready", "recently", "unconfirmed"]);

/** The states in which Personalize, Try again or Work out my circle again can be tapped. */
const CAN_START: ReadonlySet<CircleState> = new Set<CircleState>(["off", "unconfirmed", "busy", "failed", "unavailable"]);

/**
 * Holds the person's circle for the parts of the app below it (`useCircle`): the toggle, the view and
 * Personalize; and gives it to the scores store once it is ready, which reads its ranks for My circle
 * (none, once it is not: signed out, or someone else). It must be inside the account provider, the
 * scores provider (whose readers read the scorer's relay) and the places provider (the returning
 * visitor's look waits for the places). Nothing happens while My circle is closed
 * (`config.features.circle`), or nobody is signed in.
 */
export function CircleProvider({ children }: { children: ReactNode }): JSX.Element {
  const { account, restoring } = useAccount();
  const { readers } = useRelays();
  const store = useScoresStore("CircleProvider");
  const placesIn = usePlaces().places.length > 0;
  const who = account?.pubkey ?? (restoring ? readSession()?.pubkey : undefined);
  const [shown, setShown] = useState(() => shownFor(who));
  // Someone signed in, out, or someone else: their circle, from what the tab keeps of it.
  if (shown.who !== who) setShown(shownFor(who));

  // The account the tap was made with, whose signer asks the person.
  const tappedWith = useRef<Account | undefined>(undefined);

  /**
   * A flow's step: what it sets is taken only while it is the flow under way, for the same person. A
   * flow that finds the circle worked out (again), or under way again, lets go of the count the Why
   * page kept of it.
   */
  const stepFor = useCallback(
    (pubkey: string, id: number, signal: AbortSignal): Step => ({
      pubkey,
      signal,
      readers,
      set(change) {
        if (signal.aborted) return;
        const fresh = change.state === "ready" || change.state === "recently" || change.edition !== undefined;
        if (fresh || change.update === "started") forgetCircleCount();
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

  // The tap's flow, polling after a reload, or Update now's. It lives here, above the pages: leaving
  // the Why page, or the window crossing between the phone's layout and the desktop's, stops nothing.
  const working = shown.flow !== null && shown.flow.mode !== "check" ? shown.flow : null;
  useEffect(() => {
    if (working === null || shown.who === undefined) return;
    const stop = new AbortController();
    const step = stepFor(shown.who, working.id, stop.signal);
    const tapped = tappedWith.current;
    if (working.mode === "resume") {
      void resume(step, shown.since ?? Date.now());
    } else if (tapped?.pubkey !== shown.who) {
      step.set(working.mode === "update" ? { update: "idle", flow: null } : { state: "off", flow: null });
    } else if (working.mode === "update") {
      void rework(step, tapped);
    } else {
      void start(step, tapped);
    }
    return () => stop.abort();
    // `since` is read as the flow starts: the flow setting it after starts no other.
  }, [working, shown.who, stepFor]);

  // Kept for the tab, as it changes.
  useEffect(() => {
    const { who: pubkey, state, since, scorer, notice } = shown;
    if (pubkey === undefined || !config.features.circle || state === "checking" || state === "signing") return;
    if (state === "working") {
      // Kept once a run is known; until then, what was kept before stays.
      if (since !== undefined) keep({ pubkey, state, since });
    } else if ((state === "ready" || state === "recently" || state === "unconfirmed") && scorer !== undefined) {
      keep({ pubkey, state, scorer, notice });
    } else {
      keep({ pubkey, state });
    }
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
    setShown((current) =>
      current.who === account.pubkey && CAN_START.has(current.state)
        ? { ...current, state, since: undefined, notice: false, update: "idle", flow }
        : current,
    );
  }, [account]);

  const update = useCallback(() => {
    const can = (at: Shown) => at.who === account?.pubkey && SHOWN.has(at.state) && at.scorer !== undefined && at.flow === null;
    if (!config.features.circle || account === undefined || !can(latest.current)) return;
    tappedWith.current = account;
    // With a sign-in this tab already has, the add-on is not asked.
    const step: UpdateStep = readToken(account.pubkey) === null ? "signing" : "updating";
    const flow = newFlow("update");
    setShown((current) => (can(current) ? { ...current, update: step, flow } : current));
  }, [account]);

  const cancel = useCallback(() => {
    setShown((now) => {
      if (now.update === "signing") return { ...now, update: "idle", flow: null };
      return now.state === "signing" ? { ...now, state: "off", flow: null } : now;
    });
  }, []);

  const dismissReady = useCallback(() => {
    setShown((now) => (now.notice ? { ...now, state: now.state === "recently" ? "ready" : now.state, notice: false } : now));
  }, []);

  const ready = SHOWN.has(shown.state) && shown.scorer !== undefined;

  // The scores store reads the circle's ranks once it is ready, beside the house's, so that toggling
  // to My circle reads nothing; before the page is drawn, so My circle never shows without them asked
  // for. An unconfirmed circle's are read afresh once it is confirmed (ruling R10), and any circle's
  // once Update now has had it worked out again (a new edition).
  const owner = ready ? shown.who : undefined;
  const scorerKey = ready ? shown.scorer?.pubkey : undefined;
  const scorerRelay = ready ? shown.scorer?.relay : undefined;
  const confirmed = shown.state !== "unconfirmed";
  const { edition } = shown;
  useLayoutEffect(() => {
    store.setCircle(
      owner !== undefined && scorerKey !== undefined && scorerRelay !== undefined
        ? { owner, scorer: { pubkey: scorerKey, relay: scorerRelay }, confirmed, edition }
        : undefined,
    );
  }, [store, owner, scorerKey, scorerRelay, confirmed, edition]);

  // A rank by the scorer of an unconfirmed circle, found by the store since the look: its run has
  // published, so the circle is confirmed, quietly (ruling R10).
  const rankedNow = useCallback(() => store.circleRanked(owner, scorerKey), [store, owner, scorerKey]);
  const ranked = useSyncExternalStore(store.subscribe, rankedNow);
  useEffect(() => {
    if (!ranked) return;
    forgetCircleCount();
    setShown((now) => (now.state === "unconfirmed" && now.scorer?.pubkey === scorerKey ? { ...now, state: "ready" } : now));
  }, [ranked, scorerKey]);

  const value = useMemo<CircleValue>(
    () => ({
      state: shown.state,
      ready,
      scorer: ready ? shown.scorer : undefined,
      notice: ready && shown.notice,
      updateStep: shown.update,
      edition,
      personalize,
      retry: personalize,
      update,
      cancel,
      dismissReady,
    }),
    [shown.state, shown.scorer, shown.notice, shown.update, edition, ready, personalize, update, cancel, dismissReady],
  );
  return <CircleContext value={value}>{children}</CircleContext>;
}
