/*
 * One thing at a time across the person's tabs, by a lock of the browser's (Web Locks). Brainstorm's
 * sign-in (src/circle/brainstorm.ts) and a change to the follow list (src/follow/change.ts) each run
 * under one, with a name and a wait of their own. This imports nothing, so the chunk of either can
 * hold it, and it asks for no lock until it is called.
 */

/**
 * Runs `task` while holding the browser's lock `name`, so that one task of that name runs at a time
 * across the person's tabs: a second waits for the first to end, however it ends. It waits for the
 * lock at most `waitMs`, or until the browser will not lend it, then goes ahead without it: no wait
 * goes on for ever. The wait counts from the request, not from when the tab ahead got the lock, so
 * of three tabs waiting in turn the third can go ahead while the second, which got the lock late,
 * still holds it: the price of never waiting for ever. In a browser with no Web Locks it goes ahead
 * at once, unguarded.
 *
 * Gives what `task` gives. A task that fails while it holds the lock fails here as it did, and is
 * not run again. Rejects with the signal's reason when `signal` aborts while it waits for the lock;
 * once `task` runs, stopping it is `task`'s own to do.
 */
export async function withTabLock<T>(name: string, waitMs: number, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  // Every browser the app supports has Web Locks. They are only there in a secure context, which the
  // app needs anyway (Nostrify's crypto.randomUUID is only there too).
  if (typeof locks?.request !== "function") return task();
  const wait = new AbortController();
  const timer = setTimeout(() => wait.abort(new DOMException("Another tab held the lock too long", "TimeoutError")), waitMs);
  let granted = false;
  try {
    return await locks.request(name, { signal: AbortSignal.any([signal, wait.signal]) }, () => {
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
