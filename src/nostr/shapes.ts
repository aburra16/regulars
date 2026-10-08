/*
 * Checks on values that come from relays, events and the environment, all untrusted text.
 * Kept apart from everything else so that src/config.ts can use them as it loads.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

/** Whether `text` is a public key as events carry it: 64 lowercase hex digits. */
export function isPubkey(text: string): boolean {
  return HEX_64.test(text);
}

/** Whether `text` is a URL the app can open a relay at: `ws:` or `wss:`. */
export function isRelayUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
