/*
 * Brainstorm's client (./brainstorm.ts), loaded when it is first needed, and once, for whoever needs
 * it: the circle's provider (./CircleProvider.tsx) and the Why page's count (./circleSize.ts). It is
 * the one module that imports the client, and imports it only through a dynamic import(), so the client
 * stays a chunk of its own, out of the first screen's code (tests/relay-chunk.test.ts).
 */

export type Client = typeof import("./brainstorm.ts");

let clientCode: Promise<Client> | undefined;

/** Brainstorm's client, loaded once. A load that fails is tried again next time. */
export function loadBrainstorm(): Promise<Client> {
  clientCode ??= import("./brainstorm.ts").catch((error: unknown) => {
    clientCode = undefined;
    throw error;
  });
  return clientCode;
}
