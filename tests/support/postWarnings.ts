import { vi } from "vitest";

/*
 * The posting code's warnings (src/review/post.ts): one line for each try a relay did not take a
 * review or a removal, "[post] <relay> did not take it: <what it said>". A test whose relays refuse
 * would print them all; these keep them off its output, and let it read them.
 */

/** Whether a warning is one of the posting code's. */
const isPosts = (first: unknown) => typeof first === "string" && first.startsWith("[post] ");

/**
 * Holds back the posting code's warnings until the test ends (`vi.restoreAllMocks`), and lets any
 * other warning through. The spy keeps every call, for `postWarnings`.
 */
export function quietPostWarnings() {
  const warn = console.warn.bind(console);
  return vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (!isPosts(args[0])) warn(...args);
  });
}

/** Each of the posting code's warnings so far, as its text, in order: `spy` is `quietPostWarnings`'s. */
export function postWarnings(spy: ReturnType<typeof quietPostWarnings>): string[] {
  return spy.mock.calls.flatMap((args: unknown[]) => (isPosts(args[0]) ? [String(args[0])] : []));
}
