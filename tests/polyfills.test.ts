import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = AbortSignal.any;

/** The browser as Safari before 17.4 has it: no `AbortSignal.any`. */
function withoutAny(): void {
  Reflect.deleteProperty(AbortSignal, "any");
  expect(AbortSignal.any).toBeUndefined();
}

/** Loads src/polyfills.ts afresh, as main.tsx does on a page's first load. */
async function loadPolyfills(): Promise<void> {
  vi.resetModules();
  await import("../src/polyfills");
}

beforeEach(withoutAny);

afterEach(() => {
  AbortSignal.any = native;
});

describe("the AbortSignal.any polyfill", () => {
  it("is put in place when the browser has none", async () => {
    await loadPolyfills();
    expect(typeof AbortSignal.any).toBe("function");
  });

  it("leaves the browser's own alone", async () => {
    AbortSignal.any = native;
    await loadPolyfills();
    expect(AbortSignal.any).toBe(native);
  });

  it("aborts when any of its signals aborts, with that signal's reason", async () => {
    await loadPolyfills();
    for (const which of [0, 1, 2]) {
      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const combined = AbortSignal.any(controllers.map((controller) => controller.signal));
      expect(combined.aborted).toBe(false);
      const reason = new Error(`signal ${which}`);
      controllers[which]!.abort(reason);
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe(reason);
      // A second signal that aborts later does not change why.
      controllers[(which + 1) % 3]!.abort(new Error("later"));
      expect(combined.reason).toBe(reason);
    }
  });

  it("is aborted at once when a signal is already, with its reason", async () => {
    await loadPolyfills();
    const reason = new DOMException("Too slow", "TimeoutError");
    const combined = AbortSignal.any([new AbortController().signal, AbortSignal.abort(reason)]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
  });

  it("tells its listeners, as the relay's request listens", async () => {
    await loadPolyfills();
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal]);
    const heard = vi.fn();
    combined.addEventListener("abort", heard);
    controller.abort();
    expect(heard).toHaveBeenCalledTimes(1);
    expect((combined.reason as DOMException).name).toBe("AbortError");
  });

  it("never aborts for no signals", async () => {
    await loadPolyfills();
    expect(AbortSignal.any([]).aborted).toBe(false);
  });

  it("is loaded by main.tsx before anything else", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const firstImport = /^import\s+(?:.+\s+from\s+)?"([^"]+)";/m.exec(main)?.[1];
    expect(firstImport).toBe("./polyfills.ts");
  });
});
