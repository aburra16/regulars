/**
 * A device whose main pointer is a finger, and which cannot hover: a phone or a tablet. A laptop with
 * a touch screen hovers with its trackpad or mouse, and a computer's narrow window is still a computer's.
 */
export const HANDHELD_QUERY = "(pointer: coarse) and (hover: none)";

/** What some browsers say of the device (User-Agent Client Hints): `mobile` for a phone, not a tablet. */
interface WithClientHints {
  userAgentData?: { mobile?: boolean };
}

/**
 * Whether the device is a phone or a tablet, which the person's phone app may be on, judged by the
 * device and never by the window's width: the browser says it is mobile, where it says (Chromium's
 * `navigator.userAgentData`, which calls a tablet not mobile), or its main pointer is coarse and it
 * cannot hover (`HANDHELD_QUERY`). A browser that can say neither is taken for a computer's.
 */
export function isHandheld(): boolean {
  if (typeof navigator !== "undefined" && (navigator as WithClientHints).userAgentData?.mobile === true) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(HANDHELD_QUERY).matches;
}
