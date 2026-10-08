import { useCallback, useEffect, useRef, useState } from "react";

import { useConnectIfAny } from "../account/AccountProvider.tsx";

/** How asking the add-on ended: the person is signed in, it said no or failed, or it was stopped. */
export type Asked = "in" | "failed" | "stopped";

/**
 * Signing in with the browser's add-on (NIP-07), at once: one question to it, who the person is,
 * which it may put to the person first (src/account/connect.ts). For Continue on the sign-in page and
 * for Rate this place, which signs a person in where they are (decision 23). One question at a time:
 * asking again stops the one before. It stops when the component goes. Outside an `AccountProvider`
 * there is nothing to sign in to, and asking fails.
 */
export function useAddOnSignIn(): { asking: boolean; ask(): Promise<Asked>; stop(): void } {
  const connect = useConnectIfAny();
  const [asking, setAsking] = useState(false);
  const current = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  const stop = useCallback(() => {
    current.current?.abort();
    current.current = null;
    setAsking(false);
  }, []);

  const ask = useCallback(async (): Promise<Asked> => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setAsking(true);
    try {
      if (connect === undefined) throw new Error("Nothing to sign in to");
      await connect.browser(controller.signal);
      return "in";
    } catch {
      return controller.signal.aborted ? "stopped" : "failed";
    } finally {
      if (current.current === controller) {
        current.current = null;
        setAsking(false);
      }
    }
  }, [connect]);

  return { asking, ask, stop };
}
