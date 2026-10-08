import { useEffect, useState } from "react";

/** How often the clock is read again. Opening hours change on the minute. */
const TICK_MS = 60_000;

/**
 * The current time, read again every minute and whenever the page comes back into view, so that
 * "Open until 11 pm" turns into "Closed · opens 7 am" on a screen left open. A background tab or a
 * sleeping phone runs its timers late, which is why the return to view reads it as well.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const read = () => setNow(new Date());
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    const timer = setInterval(read, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return now;
}
