/**
 * What Continue opens on the sign-in page (./ChooseHow.tsx), with the QR code's library: a chunk of
 * its own. Each call asks for it afresh, so that a fetch that failed (a flaky network, or a deploy
 * that replaced the chunk) is tried again rather than remembered.
 */
export function loadChooseHow(): Promise<typeof import("./ChooseHow.tsx")> {
  return import("./ChooseHow.tsx");
}
