import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetScrollOfFreshVisit, SCROLL_POSITIONS_KEY, scrollKey } from "../src/shell/scrollKey";

/** The browser says how this page was loaded: a fresh visit, a reload, or Back or Forward. */
function loadedBy(type: "navigate" | "reload" | "back_forward"): void {
  vi.spyOn(performance, "getEntriesByType").mockImplementation((entryType: string) =>
    entryType === "navigation" ? ([{ type }] as unknown as PerformanceEntryList) : [],
  );
}

const positions = () => JSON.parse(window.sessionStorage.getItem(SCROLL_POSITIONS_KEY) ?? "{}") as Record<string, number>;

beforeEach(() => {
  window.history.replaceState(null, "", "/about#signing-in");
  window.sessionStorage.setItem(SCROLL_POSITIONS_KEY, JSON.stringify({ "/about#signing-in": 640, "/": 1200, "x7k2": 300 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a page opened afresh", () => {
  it("is React Router's own store of positions, under the key the app gives a first page", () => {
    expect(SCROLL_POSITIONS_KEY).toBe("react-router-scroll-positions");
    expect(scrollKey({ key: "default", pathname: "/about", search: "", hash: "#signing-in" })).toBe("/about#signing-in");
  });

  it("forgets where an earlier visit left this address, so it opens where the address says", () => {
    loadedBy("navigate");
    forgetScrollOfFreshVisit();
    expect(positions()).toEqual({ "/": 1200, x7k2: 300 });
  });

  it.each(["reload", "back_forward"] as const)("keeps it for a %s, which puts the page back where it was", (type) => {
    loadedBy(type);
    forgetScrollOfFreshVisit();
    expect(positions()).toEqual({ "/about#signing-in": 640, "/": 1200, x7k2: 300 });
  });

  it("does nothing, and does not throw, when nothing was kept or what was kept cannot be read", () => {
    loadedBy("navigate");
    window.sessionStorage.removeItem(SCROLL_POSITIONS_KEY);
    expect(() => forgetScrollOfFreshVisit()).not.toThrow();
    expect(window.sessionStorage.getItem(SCROLL_POSITIONS_KEY)).toBeNull();
    window.sessionStorage.setItem(SCROLL_POSITIONS_KEY, "not json");
    expect(() => forgetScrollOfFreshVisit()).not.toThrow();
  });

  it("is done by main.tsx before the router starts", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const forget = main.indexOf("forgetScrollOfFreshVisit()");
    expect(forget).toBeGreaterThan(-1);
    expect(forget).toBeLessThan(main.indexOf("createBrowserRouter(routes)"));
  });
});
