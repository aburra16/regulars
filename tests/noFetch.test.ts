import { afterEach, describe, expect, it, vi } from "vitest";

import { takeReached } from "./support/noFetch";

/*
 * Tests never reach the network over fetch (tests/setup.ts, ruling R3), as they never open a socket:
 * the real fetch is replaced by one that fails, and tests/setup.ts fails the test that called it,
 * even where the code under test catches what it threw. A test that needs fetch stubs it.
 */
describe("fetch in a test (tests/setup.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails, and is noted so that the test fails, unless the test stubs it", async () => {
    await expect(fetch("https://example.test/a")).rejects.toThrow(/must not reach the network/);
    await expect(window.fetch(new URL("https://example.test/b"))).rejects.toThrow(/must not reach the network/);
    await expect(fetch(new Request("https://example.test/c"))).rejects.toThrow(/must not reach the network/);

    // Taken here, so that tests/setup.ts does not fail this test for them.
    expect(takeReached()).toEqual(["https://example.test/a", "https://example.test/b", "https://example.test/c"]);
    expect(takeReached()).toEqual([]);
  });

  it("is the test's own once stubbed, and blocked again once the stub is undone", async () => {
    const stub = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", stub);
    await expect(fetch("https://example.test/").then((response) => response.text())).resolves.toBe("ok");
    expect(stub).toHaveBeenCalledTimes(1);
    expect(takeReached()).toEqual([]);

    vi.unstubAllGlobals();
    await expect(fetch("https://example.test/")).rejects.toThrow(/must not reach the network/);
    expect(takeReached()).toEqual(["https://example.test/"]);
  });
});
