/*
 * The browser's locks (Web Locks), played in memory: jsdom has none. One of these stands for one
 * browser, shared by every tab a test opens, so that what one tab holds another waits for.
 */

/** `navigator.locks` as a browser has it, for exclusive locks: one holder per name, the others waiting in turn. */
export class FakeLocks {
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

/** Gives the browser `value` for its locks; undefined, a browser with no Web Locks, as jsdom is. */
export function useLocks(value: Pick<FakeLocks, "request"> | undefined): void {
  Object.defineProperty(window.navigator, "locks", { configurable: true, value });
}
