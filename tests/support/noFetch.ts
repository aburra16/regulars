/*
 * Tests never reach the network over fetch (ruling R3), as they never open a socket (tests/setup.ts).
 * tests/setup.ts puts `noFetch` in place of the real fetch, and a test that needs fetch stubs it
 * (`vi.stubGlobal("fetch", …)`). Code under test may well catch what fetch throws (a request that
 * fails is one it handles), so each call is also noted, and tests/setup.ts fails the test that made it.
 */

const reached: string[] = [];

/** fetch, in a test that has not stubbed it: noted, and failed, as a request with no network is. */
export async function noFetch(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  reached.push(url);
  throw new Error(`Tests must not reach the network: fetch ${url}. Stub fetch instead (vi.stubGlobal).`);
}

/** The addresses the real fetch was asked for since the last call, which are then forgotten. */
export function takeReached(): string[] {
  return reached.splice(0);
}
