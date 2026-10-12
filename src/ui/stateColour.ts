import type { OpenState } from "../places/hours.ts";

/**
 * The colour of the words that say whether a place is open, wherever the hours are a line:
 * red, the accent, for "Closed"; green for "Open"; amber for "Closing soon", within 45
 * minutes of closing (`closingSoon`), and the same amber for "Opening soon", within 45 minutes of
 * opening (`openingSoon`). Only those words: they say which already, so the colour is
 * never the only sign. Undefined for hours that are not listed or not read.
 */
export function stateColour(state: OpenState): string | undefined {
  if (state.kind === "closed") return state.openingSoon === true ? "text-soon" : "text-accent";
  if (state.kind === "open") return state.closingSoon === true ? "text-soon" : "text-open-now";
  return undefined;
}
