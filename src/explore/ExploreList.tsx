import { type JSX, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { EmptyCircle } from "../circle/EmptyCircle.tsx";
import { Personalize } from "../circle/Personalize.tsx";
import { WHY_PATH } from "../circle/paths.ts";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { HereCityPicker } from "../location/CityPicker.tsx";
import { useHere } from "../location/useLocation.ts";
import { groupForList } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useScoreActions } from "../score/useScore.ts";
import { FROM_EXPLORE } from "../search/filters.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { PageMessage, primaryButton, retryButton } from "../ui/Banner.tsx";
import { ChipLink, Chips } from "../ui/Chips.tsx";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { HouseName } from "../ui/HouseName.tsx";
import { SearchIcon } from "../ui/icons.tsx";
import { shownPageOf } from "../ui/shown.ts";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { useCurrentView } from "../view/ViewProvider.tsx";
import {
  CHIP_LABELS,
  CHIP_PARAM,
  chipFromParam,
  chipKeeps,
  EXPLORE_CHIPS,
  type ExploreChip,
  filtersPathFrom,
} from "./chips.ts";
import { Entries } from "./Entries.tsx";
import { setExploreIdx } from "./returnPoint.ts";

const CHIP_OPTIONS = EXPLORE_CHIPS.map((id) => ({ id, label: CHIP_LABELS[id] }));

/**
 * The search field of the phone's Explore: it looks like a field and opens the search page
 * (Main.dc.html). Over the map it is white, with a shadow (Map.dc.html).
 */
export function SearchLink({ onMap = false }: { onMap?: boolean }): JSX.Element {
  return (
    <Link
      to="/search"
      className={`flex h-13 items-center gap-2.5 rounded-button px-4 text-body text-muted no-underline ${
        onMap ? "bg-ground shadow-float" : "bg-surface"
      }`}
    >
      <SearchIcon size={20} className="shrink-0" />
      <span>
        <span className="sr-only">{copy.search.label}:</span> {copy.search.placeholder}
      </span>
    </Link>
  );
}

/** No place is listed around the point: say so, and offer another town. */
export function NoneNearby(): JSX.Element {
  const here = useHere();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <PageMessage
        action={
          <button type="button" aria-haspopup="dialog" onClick={() => setPicking(true)} className={primaryButton}>
            {copy.explore.chooseTown}
          </button>
        }
      >
        {copy.explore.noneNearby(here.label)}
      </PageMessage>
      {picking && <HereCityPicker onClose={() => setPicking(false)} />}
    </>
  );
}

/**
 * Whose scores the list shows, by the view on screen, and a link to how that works (Main.dc.html):
 * the house's reviewers, with its badge beside its name, or the person's circle. While My circle is
 * the view and nobody in it has rated the places seen, a line under it says so (`EmptyCircle`). The
 * desktop's Explore says how many places there are first (DeskExplore.dc.html):
 * how many the list has; or, when an area searched on the map has more than the list holds, how many
 * the area has (`inArea`); or, when Open now stopped reading hours before it found that many open
 * places, that it shows the open ones nearest the middle (`nearestOnly`).
 *
 * A screen reader hears that sentence when the person changes the list (a filter, a search, a town),
 * and not the line around it. `announceKey` names the list: the sentence is said when the key changes,
 * and not when only the minutes passing change it (Open now's places opening and closing). So the
 * sentence is drawn as it is now, hidden from a screen reader, and said in a polite status, hidden from
 * the eye, as it was when the list was last made.
 * When the view can't be worked out (`unavailable`), one quiet line under it says so, with Try again,
 * which asks again (`onRetry`). The focus goes to the lines then, where the button was: the button
 * goes once the view is back, and the focus would fall to the page. `className` spaces the lines as
 * the page around them spaces its own.
 */
export function ViewLine({
  count,
  inArea,
  nearestOnly = false,
  announceKey,
  unavailable = false,
  onRetry,
  className,
}: {
  count?: number;
  inArea?: number;
  nearestOnly?: boolean;
  announceKey?: string;
  unavailable?: boolean;
  onRetry(): void;
  className: string;
}): JSX.Element {
  const lines = useRef<HTMLDivElement>(null);
  const quietId = useId();
  const view = useCurrentView();
  let sentence: string | undefined;
  if (count !== undefined) {
    if (nearestOnly && count > 0) sentence = copy.deskExplore.nearestOpen;
    else sentence = inArea === undefined ? copy.deskExplore.count(count) : copy.deskExplore.inArea(inArea);
  }
  // What the status says: the sentence as it was when the list was last made.
  const [said, setSaid] = useState({ key: announceKey, sentence });
  if (said.key !== announceKey) setSaid({ key: announceKey, sentence });
  return (
    <div ref={lines} tabIndex={-1} className={`flex flex-col outline-none ${className}`}>
      <div>
        <p className="m-0 text-secondary leading-[1.4] text-muted">
          {sentence !== undefined && (
            <>
              <span aria-hidden="true">{sentence}</span>
              <span role="status" className="sr-only">
                {said.sentence}
              </span>{" "}
            </>
          )}
          {view === "circle" ? copy.explore.circleLine : <HouseName text={copy.explore.houseLine} size="line" />}{" "}
          <Link to={WHY_PATH} className="font-semibold text-ink underline hover:text-accent">
            {copy.explore.howThisWorks}
          </Link>
        </p>
        {/* Always there, for a screen reader; its line, when there is one, a little under the one above. */}
        <EmptyCircle className="*:mt-2" withPersonalize />
      </div>
      {unavailable && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p id={quietId} className="m-0 text-secondary leading-[1.4] text-muted">
            {view === "circle" ? copy.score.circleUnavailable : copy.score.houseUnavailable}
          </p>
          <button
            type="button"
            aria-describedby={quietId}
            onClick={() => {
              lines.current?.focus({ preventScroll: true });
              onRetry();
            }}
            className={retryButton}
          >
            {copy.load.retry}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Explore, as a list (Main.dc.html; the phone's first screen). Below the top of the page, which the
 * shell draws, it has the search field, the toggle, Personalize under it for a person signed in whose
 * circle is not ready (and the banner while it gets ready, Tuning.dc.html), the filter chips and the
 * places near the person, nearest first, chains as one card. A chip is kept in the address, so Back undoes it.
 * The desktop has its own Explore, with the map beside the list (DeskExplore).
 */
export function ExploreList(): JSX.Element {
  useDocumentTitle(copy.titles.explore);
  const here = useHere();
  const indexes = useIndexes();
  const now = useNow();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const { key: historyKey } = useLocation();
  const chip = chipFromParam(params.get(CHIP_PARAM));

  // Where Explore is in the history, for the search's back arrow: whenever it is on screen, so the last
  // entry it was at is the one the person left it from (see returnPoint.ts). It is read as the page is
  // drawn, in the same step: an effect that ran later could read the entry of a link pressed meanwhile.
  useLayoutEffect(() => {
    setExploreIdx(window.history.state?.idx);
  }, [historyKey]);

  const nearby = useMemo(
    () => indexes?.near(here.lat, here.lon, config.defaultCity.radiusKm) ?? [],
    [indexes, here.lat, here.lon],
  );
  // The minute matters to the list only when it is asked which places are open.
  const openAt = chip === "open" ? now : null;
  const grouped = useMemo(() => {
    if (indexes === undefined) return [];
    // Filter first, then group: a chain counts only the locations that stay.
    const kept = nearby.filter((row) => chipKeeps(chip, row.place, now));
    return groupForList(kept, indexes);
    // `now` is a dependency through `openAt`: it changes this list only while the chip asks about it.
  }, [indexes, nearby, chip, openAt]);
  // The scores of the whole list, asked for in one go. The list stays nearest first.
  const { entries, scores } = useListScores(grouped);
  const { refresh } = useScoreActions();
  // The toggle and its line, which keep the focus when Personalize's notice is put away.
  const toggleBlock = useRef<HTMLDivElement>(null);

  const choose = (next: ExploreChip) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === "all") updated.delete(CHIP_PARAM);
      else updated.set(CHIP_PARAM, next);
      return updated;
    });

  let body: JSX.Element;
  if (nearby.length === 0) {
    body = <NoneNearby />;
  } else if (entries.length === 0) {
    body = (
      <PageMessage
        action={
          <button type="button" onClick={() => choose("all")} className={primaryButton}>
            {copy.explore.showAll}
          </button>
        }
      >
        {copy.explore.noneMatching}
      </PageMessage>
    );
  } else {
    // A new chip is a new page of the history, and a new town is a new list: each starts from its first thirty.
    // The first page of a tab has the key "default", and so has any address typed in or followed from elsewhere:
    // its depth is kept in memory only, where a reload clears it (see `ShownPage`).
    const list = `${chip}|${here.lat}|${here.lon}`;
    const page = shownPageOf(historyKey, list);
    body = (
      <div className="px-gutter-phone pt-[18px]">
        <Entries key={`${historyKey}|${list}`} page={page} entries={entries} locale={locale} now={now} scores={scores} />
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-5">
      <div className="flex flex-col gap-4 px-gutter-phone pt-4">
        <h1 className="sr-only">{copy.pages.explore}</h1>
        <SearchLink />
        <div ref={toggleBlock} tabIndex={-1} className="flex flex-col gap-2 outline-none">
          <ViewSwitch variant="bar" />
          <ViewLine unavailable={scores.state === "unavailable"} onRetry={refresh} className="gap-2" />
        </div>
        <Personalize holdFocus={toggleBlock} />
        <Chips
          label={copy.explore.filtersLabel}
          options={CHIP_OPTIONS}
          value={chip}
          resting="all"
          onChange={choose}
        >
          <ChipLink to={filtersPathFrom(chip, locale)} state={FROM_EXPLORE}>
            {copy.explore.chips.more}
          </ChipLink>
        </Chips>
      </div>
      {body}
      <footer className="mt-auto px-gutter-phone pt-[18px]">
        <DetailsCredit />
      </footer>
    </div>
  );
}
