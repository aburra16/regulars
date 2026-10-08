import { useCallback, useEffect, useRef, useState } from "react";

import { useConnect } from "../account/AccountProvider.tsx";

/** How asking the add-on ended: the person is signed in, it said no, failed or did not answer in time, or it was stopped. */
export type Asked = "in" | "failed" | "stopped";

/**
 * Signing in with the browser's add-on (NIP-07), at once: one question to it, who the person is,
 * which it may put to the person first, with a minute to answer (src/account/connect.ts). For
 * Continue on the sign-in page, and for Rate this place and the account button, which sign a person
 * in where they are (decision 23). One question at a time: asking again stops the one before. It
 * stops when the component goes, and once it has gone it asks nothing.
 */
export function useAddOnSignIn(): { asking: boolean; ask(): Promise<Asked>; stop(): void } {
  const connect = useConnect();
  const [asking, setAsking] = useState(false);
  const current = useRef<AbortController | null>(null);
  const gone = useRef(false);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      current.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    current.current?.abort();
    current.current = null;
    setAsking(false);
  }, []);

  const ask = useCallback(async (): Promise<Asked> => {
    if (gone.current) return "stopped";
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setAsking(true);
    try {
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
