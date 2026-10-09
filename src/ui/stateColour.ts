import type { OpenState } from "../places/hours.ts";

/**
 * The colour of the word that says whether a place is open, wherever the hours are a line (Avi,
 * 2026-10-09): red, the accent, when it is closed; green when it is open; amber when it closes within
 * 45 minutes (`closingSoon`). Only that word, and in the same words: they say Open or Closed already,
 * so the colour is never the only sign. Undefined for hours that are not listed or not read.
 */
export function stateColour(state: OpenState): string | undefined {
  if (state.kind === "closed") return "text-accent";
  if (state.kind === "open") return state.closingSoon === true ? "text-closing-soon" : "text-open-now";
  return undefined;
}
