import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { osmNoteUrl } from "../place/osmLinks.ts";
import { NewTabHint } from "../ui/NewTab.tsx";
import { useCurrentView } from "../view/ViewProvider.tsx";
import type { Order } from "./useResults.ts";

/*
 * The parts of the search results that the phone's page (Search.dc.html) and the desktop's (the
 * results in Explore's layout, D1) both have: the line of how many, or the sentence that says there
 * is nothing, in one live region; the note on the closed places Open now left out; and the link to
 * add a place that is missing.
 */

/** How much of a search a sentence says back: a search that is a paragraph, or one long word, would fill the page. */
const ECHO_MAX = 80;

/** The words searched for as a sentence says them: the first eighty characters, then an ellipsis. Cut between characters, not through one. */
function echo(query: string): string {
  const characters = [...query];
  return characters.length > ECHO_MAX ? `${characters.slice(0, ECHO_MAX).join("")}…` : query;
}

/** What the page says in place of the results, and a hint under it. */
export interface EmptyMessage {
  sentence: string;
  hint?: string;
}

/**
 * What the page says in place of the rows, and a hint under it. Nothing here went wrong, so none
 * of it is an alert. `openLeftNone`: Open now is what left none, closed places match.
 */
export function emptyMessage({
  query,
  near,
  filtersOn,
  openLeftNone,
}: {
  query: string;
  near: string;
  filtersOn: boolean;
  openLeftNone: boolean;
}): EmptyMessage {
  if (openLeftNone) {
    return { sentence: query === "" ? copy.search.noResultsFiltered(near) : copy.search.noResultsOpen(echo(query), near) };
  }
  if (query !== "") return { sentence: copy.search.noResults(echo(query), near), hint: copy.search.noResultsHint };
  if (filtersOn) return { sentence: copy.search.noResultsFiltered(near), hint: copy.search.noResultsFilteredHint };
  return { sentence: copy.explore.noneNearby(near) };
}

/**
 * The line under the filters (Search.dc.html): how many places, near where, in what order (best first
 * by the view on screen, when by score); or, when there are none, the sentence that says so. It is one
 * live region that is always on the page, so a screen reader announces each change to it.
 */
export function ResultsLine({
  empty,
  count,
  near,
  order,
  className = "",
}: {
  empty: EmptyMessage | undefined;
  count: number;
  near: string;
  order: Order;
  className?: string;
}): JSX.Element {
  const view = useCurrentView();
  const sortedBy = order === "score" && view === "circle" ? copy.search.sortedBy.circleScore : copy.search.sortedBy[order];
  return (
    <div role="status" className={className}>
      {empty === undefined ? (
        <p className="m-0 text-secondary leading-[1.4] text-muted">{copy.search.summary(count, near, sortedBy)}</p>
      ) : (
        <p className="m-0 min-w-0 text-body leading-[1.5] wrap-break-word text-ink-soft">{empty.sentence}</p>
      )}
    </div>
  );
}

/** The hint under the sentence that says there is nothing. */
export function EmptyHint({ hint }: { hint: string }): JSX.Element {
  return <p className="m-0 text-secondary leading-[1.4] text-muted">{hint}</p>;
}

/** The box under the results when Open now left some out (Search.dc.html), with a way to bring them back. */
export function HiddenClosedNote({ count, onShowClosed }: { count: number; onShowClosed(): void }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5 rounded-card bg-surface p-4">
      <div className="text-[15px] font-bold">{copy.search.hiddenClosed(count)}</div>
      <div className="text-secondary leading-[1.45] text-muted">{copy.search.hoursNote}</div>
      <button
        type="button"
        onClick={onShowClosed}
        className="h-11 cursor-pointer self-start border-0 bg-transparent p-0 font-text text-secondary font-bold text-accent"
      >
        {copy.search.showClosed}
      </button>
    </section>
  );
}

/** A place rounded to four decimals, about eleven metres: as exact as a note about a missing place needs, and no more of where a person is. */
const round4 = (degrees: number) => Math.round(degrees * 1e4) / 1e4;

/**
 * "Can't find it? Add a missing place": a note on OpenStreetMap's map where the person is near, in a
 * new tab. Nothing when there is no such note to make.
 */
export function AddMissingLink(): JSX.Element | null {
  const here = useHere();
  const noteUrl = here.source === "device" ? osmNoteUrl(round4(here.lat), round4(here.lon)) : osmNoteUrl(here.lat, here.lon);
  if (noteUrl === "") return null;
  return (
    <a
      href={noteUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-touch items-center self-start text-caption font-semibold text-ink underline hover:text-accent"
    >
      {copy.search.addMissing}
      <NewTabHint />
    </a>
  );
}
