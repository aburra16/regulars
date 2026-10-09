import type { OpenState } from "../places/hours.ts";

/**
 * The colour of the words that say whether a place is open, wherever the hours are a line (Avi,
 * 2026-10-09): red, the accent, for "Closed"; green for "Open"; amber for "Closing soon", within 45
 * minutes of closing (`closingSoon`). Only those words: they say which already, so the colour is never
 * the only sign. Undefined for hours that are not listed or not read.
 */
export function stateColour(state: OpenState): string | undefined {
  if (state.kind === "closed") return "text-accent";
  if (state.kind === "open") return state.closingSoon === true ? "text-closing-soon" : "text-open-now";
  return undefined;
}
