import { useCallback, useEffect, useRef, useState } from "react";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { useScoresStore } from "../score/ScoresProvider.tsx";
import type { Scorer } from "../trust/houseWeights.ts";
import { type Client, loadClient } from "./client.ts";
import { MISSED_POLLS, POLL_CAP_MS, POLL_MS } from "./CircleProvider.tsx";
import { forgetToken, readToken } from "./token.ts";

/*
 * Update now, on the Why page: asks Brainstorm to work the person's circle out again (`POST
 * /user/graperank`), with the token this tab has, or, when it has none or Brainstorm says it has run
 * out, after the person approves Brainstorm's sign-in in their add-on or phone app, as Personalize does:
 * they tapped. When Brainstorm will not start one, as one was made lately (429, 403), the circle they
 * have is the one used, and the page says so (the brief's § 6). Otherwise the run is followed while the
 * page is open, every 15 s for at most 45 minutes, as Personalize's is (Global Constraints); once it
 * is done, the scores store reads the circle's ranks again, and the page counts it again. Scores use
 * the circle the person has meanwhile: My circle stays as it is, and nothing here changes its state.
 * Leaving the page stops the following, not the run: the next visit reads what Brainstorm published.
 */

/**
 * Where Update now is:
 * - `idle`: not tapped, or the person did not go on with the sign-in;
 * - `signing`: their add-on or phone app asks them to approve Brainstorm's sign-in;
 * - `updating`: Brainstorm is asked, or works the circle out, followed;
 * - `started`: it works it out, and can no longer be followed (the token ran out while it did); Update
 *   now is there again, and asks for a sign-in;
 * - `recently`: Brainstorm would not start a run, as one was made lately: that one is used;
 * - `updated`: worked out again;
 * - `failed`: the run failed, took too long, or Brainstorm could not be reached.
 */
export type UpdateStep = "idle" | "signing" | "updating" | "started" | "recently" | "updated" | "failed";

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
 * The run Update now asks for: started with `account`'s token, or a sign-in first (once more if the
 * token is refused, unless the sign-in was made just now), then followed until it is done. Says where
 * it is through `set`, and nothing once `signal` aborts. Never ends without a step that says so: no
 * spinner is left on (Review Focus 4).
 */
async function updateCircle(account: Account, set: (step: UpdateStep) => void, signal: AbortSignal): Promise<void> {
  let client: Client;
  try {
    client = await loadClient();
  } catch {
    return set("failed");
  }
  const { pubkey } = account;
  let token = readToken(pubkey);
  let asked = false;
  let started: Awaited<ReturnType<Client["startRun"]>>;
  for (;;) {
    if (token === null) {
      asked = true;
      set("signing");
      try {
        token = await client.signInToBrainstorm(pubkey, account.signer, signal, { how: account.how });
      } catch (error) {
        if (signal.aborted) return;
        // The person said no, or their signer did not answer: as before, quietly. Brainstorm's trouble says so.
        const unreachable = error instanceof client.Unavailable || error instanceof client.SignInRefused;
        return set(unreachable ? "failed" : "idle");
      }
    }
    set("updating");
    try {
      started = await client.startRun(token, signal);
      break;
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof client.TokenExpired)) return set("failed");
      forgetToken();
      token = null;
      // A sign-in made just now that is refused is Brainstorm's trouble, not the person's: no second ask.
      if (asked) return set("failed");
    }
  }
  if ("recently" in started) return set("recently");

  const since = Date.now();
  let missed = 0;
  for (;;) {
    try {
      await pause(POLL_MS, signal);
    } catch {
      return;
    }
    if (Date.now() - since >= POLL_CAP_MS) return set("failed");
    try {
      const run = await client.latestRun(token, signal);
      const where = run === null ? "failed" : client.runState(run);
      if (where === "done") return set("updated");
      if (where === "failed") return set("failed");
      missed = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof client.TokenExpired) {
        // Not followed further, and the person is not asked again: they did not act.
        forgetToken();
        return set("started");
      }
      missed += 1;
      if (missed >= MISSED_POLLS) return set("failed");
    }
  }
}

/**
 * Update now, for the circle `scorer` publishes the ranks of: where it is, the tap, and Cancel (while
 * the person is asked to approve the sign-in). `onUpdated` is called once Brainstorm has worked the
 * circle out again, after the scores store is told to read its ranks again. Signing out, or another
 * account, stops it; so does leaving the page.
 */
export function useUpdateNow(
  scorer: Scorer,
  onUpdated: () => void,
): { step: UpdateStep; update(): void; cancel(): void } {
  const { account } = useAccount();
  const store = useScoresStore("useUpdateNow");
  const [shown, setShown] = useState<{ who: string | undefined; step: UpdateStep }>({ who: account?.pubkey, step: "idle" });
  const flow = useRef<AbortController | null>(null);
  const who = account?.pubkey;
  // Another person, or nobody: what was under way was theirs.
  if (shown.who !== who) setShown({ who, step: "idle" });

  const latest = useRef({ scorer, onUpdated, store });
  useEffect(() => {
    latest.current = { scorer, onUpdated, store };
  });

  useEffect(
    () => () => {
      flow.current?.abort();
      flow.current = null;
    },
    [who],
  );

  const update = useCallback(() => {
    if (account === undefined) return;
    flow.current?.abort();
    const stop = new AbortController();
    flow.current = stop;
    const set = (step: UpdateStep) => {
      if (stop.signal.aborted) return;
      setShown((now) => (now.who === account.pubkey ? { ...now, step } : now));
      if (step === "updated") {
        // The ranks held for My circle are the old run's: the store lets go of them, and reads the new.
        const now = latest.current;
        now.store.setCircle(undefined);
        now.store.setCircle({ owner: account.pubkey, scorer: now.scorer });
        now.onUpdated();
      }
      // It has ended: there is nothing left to stop.
      if (flow.current === stop && step !== "signing" && step !== "updating") flow.current = null;
    };
    void updateCircle(account, set, stop.signal);
  }, [account]);

  const cancel = useCallback(() => {
    flow.current?.abort();
    flow.current = null;
    setShown((now) => (now.step === "signing" ? { ...now, step: "idle" } : now));
  }, []);

  return { step: shown.who === who ? shown.step : "idle", update, cancel };
}
