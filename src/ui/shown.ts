import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/**
 * Where a list keeps how many items it has shown, so that Back to it shows as many and the scroll
 * position the router restores is still on the page.
 *
 * - `history`: a page of the history that has a key of its own. The depth is kept in `sessionStorage`
 *   under that key, so it holds for as long as the tab does, a reload included.
 * - `tab`: the first page of a tab. A page that was typed in, followed from elsewhere or reloaded has
 *   the key "default" too, so a depth kept on the device under it would belong to whichever of them
 *   was there last. It is kept in memory instead, which a reload clears, so only a Back to the first
 *   page in the tab that is open can find it.
 *
 * `key` says which list it is, and the list's own place on the page, so a depth is never taken
 * to another list.
 */
export interface ShownPage {
  scope: "history" | "tab";
  key: string;
}

/** The depths of first pages, in memory: `namespace:key`. */
const inMemory = new Map<string, number>();

/** Forgets every depth that is kept in memory. A reload does the same; tests call it between one test and the next. */
export function forgetShownInMemory(): void {
  inMemory.clear();
}

/**
 * The page a list is on. `historyKey` is the router's key for the entry of the history, and `list`
 * is what the list shows (its filters and where it is near).
 */
export function shownPageOf(historyKey: string, list: string): ShownPage {
  return historyKey === "default" ? { scope: "tab", key: list } : { scope: "history", key: `${historyKey}|${list}` };
}

export interface ShownMemory {
  /** How many items this page showed last time, never more than it has and at least the first ones. */
  read(page: ShownPage, length: number): number;
  write(page: ShownPage, count: number): void;
}

/** A memory for the lists of one screen. `namespace` is the prefix of its keys; `first` is how many a list shows at first. */
export function shownMemory(namespace: string, first: number): ShownMemory {
  const keyOf = (page: ShownPage) => `${namespace}:${page.key}`;
  const fit = (count: number, length: number) =>
    Number.isInteger(count) ? Math.max(first, Math.min(count, length)) : first;
  return {
    read(page, length) {
      if (page.scope === "tab") return fit(inMemory.get(keyOf(page)) ?? first, length);
      try {
        return fit(Number(window.sessionStorage.getItem(keyOf(page))), length);
      } catch {
        // Storage that is blocked: the list starts from its first ones.
        return first;
      }
    },
    write(page, count) {
      if (page.scope === "tab") {
        inMemory.set(keyOf(page), count);
        return;
      }
      try {
        window.sessionStorage.setItem(keyOf(page), String(count));
      } catch {
        // Blocked or full. Back to this page starts from the first ones.
      }
    },
  };
}

/**
 * How many items of a list of `length` are shown, and how to change that. It starts from what the
 * page showed last time, and keeps what it shows for the next time.
 */
export function useShownCount(
  memory: ShownMemory,
  page: ShownPage,
  length: number,
): [count: number, setCount: Dispatch<SetStateAction<number>>] {
  const [count, setCount] = useState(() => memory.read(page, length));
  const { scope, key } = page;
  useEffect(() => {
    memory.write({ scope, key }, Math.min(count, length));
  }, [memory, scope, key, count, length]);
  return [count, setCount];
}
