/*
 * Brainstorm's client (./brainstorm.ts), for the Why page's count and Update now: loaded when it is
 * first needed, and once, as the circle's provider loads it (./CircleProvider.tsx). It stays a chunk
 * of its own (tests/relay-chunk.test.ts): nothing imports it but through here and the provider.
 */

export type Client = typeof import("./brainstorm.ts");

let clientCode: Promise<Client> | undefined;

/** Brainstorm's client, loaded once. A load that fails is tried again next time. */
export function loadClient(): Promise<Client> {
  clientCode ??= import("./brainstorm.ts").catch((error: unknown) => {
    clientCode = undefined;
    throw error;
  });
  return clientCode;
}
