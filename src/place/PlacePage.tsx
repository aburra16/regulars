import { type JSX, useContext, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useOutlet, useParams } from "react-router-dom";

import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type LngLat, type Pin } from "../map/BaseMap.tsx";
import { distanceKm, formatDistance } from "../places/distance.ts";
import { type OpenState, openLine, openState } from "../places/hours.ts";
import type { Indexes, PlaceDistance } from "../places/indexes.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { type RemoveReview, type RemoveStatus, useRemoveReview } from "../review/useRemoveReview.ts";
import type { Review } from "../reviews/review.ts";
import type { PlaceScore } from "../score/score.ts";
import { seenBy, type ShownScore, shownScore } from "../score/shown.ts";
import type { ViewState } from "../score/store.ts";
import { type ListScores, useListScores } from "../score/useListScores.ts";
import { useScore, useScoreActions } from "../score/useScore.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { BackLink } from "../ui/BackLink.tsx";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { SavedIcon } from "../ui/icons.tsx";
import { KindTile } from "../ui/KindTile.tsx";
import { NewTabHint } from "../ui/NewTab.tsx";
import { NotListedOrLoading } from "../ui/NotListed.tsx";
import { PlaceRow } from "../ui/PlaceRow.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { stateColour } from "../ui/stateColour.ts";
import type { View as ScoresView } from "../view/ViewProvider.tsx";
import { actionsOf, PhoneActions, type PlaceActions, RailActions } from "./Actions.tsx";
import { Facts } from "./Facts.tsx";
import { osmNoteUrl, osmUrl } from "./osmLinks.ts";
import { Reviews } from "./Reviews.tsx";
import { RateButton, RateButtonRef, ScorePanel } from "./ScorePanel.tsx";

/** How close the map is: a street and the blocks around it. */
const MAP_ZOOM = 16;

/** How many places "Nearby" lists. */
const NEARBY_COUNT = 3;

/** A link that leaves the app, to OpenStreetMap: a new tab, telling it nothing of where it came from. */
function OutLink({ href, className, children }: { href: string; className: string; children: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <NewTabHint />
    </a>
  );
}

/**
 * The bookmark at the top right of a phone's page, once saved lists open (`config.features.saved`).
 * Saving needs sign in, which can come back here.
 */
function SaveLink(): JSX.Element {
  const location = useLocation();
  return (
    <Link to="/signin" state={{ from: location }} aria-label={copy.place.save} className="flex size-11 items-center justify-center text-ink">
      <SavedIcon size={22} />
    </Link>
  );
}

/**
 * Whether the place is open, as the page says it (Place.dc.html): "Open now" or "Closed" in bold and
 * in its colour (`stateColour`: red when closed, green when open, amber when it closes soon), then the
 * rest in grey (" · closes 10 pm", or ", closes 10 pm" on a desktop, after `joiner`); "Hours not
 * listed" in grey. Hours the app cannot read are the text as written, which can be any length: one
 * line here, cut off, and the whole of it in the facts.
 */
function OpenLine({ state, line, joiner }: { state: OpenState; line: string; joiner: string }): JSX.Element {
  if (state.kind === "unknown") return <span className="text-muted">{line}</span>;
  if (state.kind === "unparsed") {
    return (
      <span title={line} className="block truncate text-muted">
        {line}
      </span>
    );
  }
  const split = line.indexOf(joiner);
  const lead = split === -1 ? line : line.slice(0, split);
  return (
    <>
      <span className={`font-bold ${stateColour(state) ?? ""}`}>{lead}</span>
      {split !== -1 && <span className="text-muted">{line.slice(split)}</span>}
    </>
  );
}

/** What the header says: the place's name, what it is and how far, and whether it is open. */
interface HeaderProps {
  place: Place;
  kindAway: string;
  state: OpenState;
  line: string;
}

/** The name, marked with its script and free to wrap anywhere: a long name or one with no spaces stays inside the page. */
function Name({ name, className }: { name: string; className: string }): JSX.Element {
  return (
    <h1
      lang={scriptLang(name)}
      dir="auto"
      tabIndex={-1}
      className={`m-0 min-w-0 font-display font-extrabold wrap-break-word outline-none ${className}`}
    >
      {name}
    </h1>
  );
}

/** The phone's header (PlaceNew.dc.html): the kind's tile, the name, what it is and how far, and the hours, one under another. */
function PhoneHeader({ place, kindAway, state, line }: HeaderProps): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-2.5 px-gutter-phone pt-1.5">
      <KindTile category={place.category} size="page" />
      <Name name={place.name} className="text-display-phone leading-[1.08] tracking-display" />
      <div className="text-[15px] leading-[normal] text-muted">{kindAway}</div>
      <div className="min-w-0 text-[15px] leading-[normal]">
        <OpenLine state={state} line={line} joiner={copy.common.joiner} />
      </div>
    </section>
  );
}

/** The desktop's header (DeskPlace.dc.html): the tile beside the name, and under it one line of what it is, how far and the hours. */
function DeskHeader({ place, kindAway, state, line }: HeaderProps): JSX.Element {
  const unread = state.kind === "unparsed";
  return (
    <section className="flex min-w-0 items-start gap-[18px]">
      <KindTile category={place.category} size="page" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Name name={place.name} className="text-display-desktop leading-[1.05] tracking-[-0.025em]" />
        <div className="text-body leading-[normal] text-muted">
          {kindAway}
          {!unread && (
            <>
              {copy.common.joiner}
              <OpenLine state={state} line={line} joiner={copy.hours.inlineJoiner} />
            </>
          )}
        </div>
        {unread && (
          <div className="min-w-0 text-body leading-[normal]">
            <OpenLine state={state} line={line} joiner={copy.hours.inlineJoiner} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The line that asks for what the place lacks (PlaceNew.dc.html): "No phone, website or hours
 * listed. Know them? Suggest a fix". The fix is a note on OpenStreetMap's map at the place, where
 * the details come from.
 */
function MissingDetails({ place, actions, state }: { place: Place; actions: PlaceActions; state: OpenState }): JSX.Element | null {
  const line = copy.place.missingDetails(place.phone === undefined, actions.site === undefined, state.kind === "unknown");
  if (line === "") return null;
  const note = osmNoteUrl(place.lat, place.lon);
  return (
    <p className="m-0 text-caption leading-[1.45] wrap-break-word text-muted">
      {line}
      {note !== "" && (
        <>
          {" "}
          <OutLink href={note} className="font-semibold text-ink underline hover:text-accent">
            {copy.place.suggestFix}
          </OutLink>
        </>
      )}
    </p>
  );
}

/**
 * The place on a map, its pin chosen, close in, with the map's attribution on it. The person can zoom
 * and move it, never turn or tilt it, and the page still scrolls past it: one finger and a plain
 * scroll move the page. Once they have moved it, a way back to the place, at the map's top left.
 * The pin is the place itself: tapping it does nothing.
 */
function PlaceMap({ place, className }: { place: Place; className: string }): JSX.Element {
  const center = useMemo<LngLat>(() => [place.lon, place.lat], [place.lon, place.lat]);
  const pins = useMemo<Pin[]>(
    () => [{ address: place.address, lat: place.lat, lon: place.lon, name: place.name, category: place.category, look: "drop" }],
    [place],
  );
  return (
    <BaseMap
      center={center}
      zoom={MAP_ZOOM}
      interactive
      cooperative
      flat
      label={copy.place.mapLabel(place.name)}
      pins={pins}
      selected={place.address}
      zoomButtons
      back={copy.place.mapBack}
      className={className}
    />
  );
}

/**
 * The places closest to this one, as compact rows, each with how far it is from here and its own
 * score (`scores`, asked for in one go). Nothing when there are none.
 */
function Nearby({
  rows,
  scores,
  locale,
  now,
  wide,
  className = "",
}: {
  rows: PlaceDistance[];
  scores: ListScores;
  locale: string;
  now: Date;
  wide: boolean;
  className?: string;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className={`flex flex-col ${className}`}>
      <h2 className={`m-0 mb-1.5 font-display font-bold ${wide ? "text-[26px]" : "text-h2"}`}>{copy.place.nearby}</h2>
      <ul role="list" className="m-0 flex list-none flex-col p-0">
        {rows.map(({ place, km }) => (
          <li key={place.address}>
            <PlaceRow place={place} km={km} from="place" score={scores.of(place.address)} locale={locale} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The foot of the page: "Something wrong? Suggest a fix", the place's own record on OpenStreetMap
 * when it has one, and where the details come from. No "Also listed by": in M1 the house curator
 * lists every place.
 */
function FootLinks({ place }: { place: Place }): JSX.Element {
  const note = osmNoteUrl(place.lat, place.lon);
  const record = place.osmId === undefined ? undefined : osmUrl(place.osmId);
  const link = "inline-flex min-h-touch items-center self-start underline hover:text-accent";
  return (
    <>
      {note !== "" && (
        <OutLink href={note} className={`${link} font-semibold text-ink`}>
          {copy.place.somethingWrong}
        </OutLink>
      )}
      {record !== undefined && (
        <OutLink href={record} className={`${link} text-muted`}>
          {copy.place.viewOnOsm}
        </OutLink>
      )}
      <DetailsCredit />
    </>
  );
}

/** Everything the page shows of a place, worked out once for both layouts. */
interface View {
  place: Place;
  kindAway: string;
  state: OpenState;
  line: string;
  actions: PlaceActions;
  /** What the score panel shows, to the person signed in (`seenBy`). */
  shown: ShownScore;
  /** The place's score from the view on screen, with its reviews inside it and folded; undefined until worked out. */
  score: PlaceScore | undefined;
  /** The review of the person signed in, of all the place's reviews; undefined when they have none. */
  mine: Review | undefined;
  /** Removing it, and where that stands. */
  removal: RemoveReview;
  /** Whose scores they are, House picks' or My circle's, and where that view's ranks stand. */
  scoresView: ScoresView;
  scoresState: ViewState;
  nearby: PlaceDistance[];
  nearbyScores: ListScores;
  /** Reads the reviews again, after a read no relay answered. */
  retry(): void;
  locale: string;
  now: Date;
}

/**
 * The reviews, once the place's score is worked out and it has some; and the person's own, as soon as
 * it is there, while the others are counted too (ruling R15). Nothing when there are none. Once the
 * person's has been removed, the focus, which was on the button that removed it, comes here, where it
 * was, and not to the page, nor anywhere that would scroll it (ruling R17); or, when theirs was the
 * only one and nothing is left here, to Rate this place (`RateButtonRef`), without scrolling either.
 */
function PlaceReviews({ view, wide, className = "" }: { view: View; wide: boolean; className?: string }): JSX.Element | null {
  const { shown, score, mine, removal, scoresView, scoresState, now } = view;
  const reviewsRef = useRef<HTMLDivElement>(null);
  const rate = useContext(RateButtonRef);
  const removed = removal.status === "removed";
  const listed = score !== undefined && (shown.kind === "scored" || shown.kind === "unscored" || shown.kind === "unavailable");
  const any = listed || mine !== undefined;
  // Once, as it is removed: what is here then, or Rate this place when nothing is.
  useEffect(() => {
    if (removed) (any ? reviewsRef.current : rate?.current)?.focus({ preventScroll: true });
  }, [removed]);
  if (!any) return null;
  return (
    <div ref={reviewsRef} tabIndex={-1} className={`outline-none ${className}`}>
      {/* On a phone, "Rate this place" goes beside the reviews' heading when the panel, with its score, has no button. */}
      <Reviews
        score={listed ? score : undefined}
        mine={mine}
        removal={removal}
        view={scoresView}
        state={scoresState}
        wide={wide}
        rate={!wide && shown.kind === "scored"}
        now={now}
      />
    </div>
  );
}

/**
 * Says politely, to a screen reader, that the person's review is being removed, and once it is: its
 * section goes from the page then, with the button that had the focus. Always on the page, so that
 * what it says is heard when it changes.
 */
function RemovalStatus({ status }: { status: RemoveStatus }): JSX.Element {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {status === "removing" ? copy.reviews.removing : status === "removed" ? copy.reviews.removed : ""}
    </p>
  );
}

/**
 * The phone's page (PlaceNew.dc.html, and Place.dc.html once it has reviews): the score panel under
 * the header, then the actions, the map and the facts, then the reviews, and the places nearby.
 */
function PhonePlace({ view }: { view: View }): JSX.Element {
  const { place, actions, state, nearby, nearbyScores, locale, now } = view;
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-3.5">
        <BackLink wide={false} />
        {config.features.saved && <SaveLink />}
      </div>
      <PhoneHeader {...view} />
      <div className="px-gutter-phone pt-[18px]">
        <ScorePanel name={place.name} wide={false} shown={view.shown} onRetry={view.retry} />
      </div>
      <div className="flex flex-col gap-2 px-gutter-phone pt-4">
        <PhoneActions actions={actions} />
        <MissingDetails place={place} actions={actions} state={state} />
      </div>
      <div className="px-gutter-phone pt-4">
        <PlaceMap place={place} className="h-[150px] rounded-panel" />
      </div>
      <div className="px-gutter-phone pt-4">
        <Facts place={place} now={now} locale={locale} />
      </div>
      <PlaceReviews view={view} wide={false} className="px-gutter-phone pt-[26px]" />
      <RemovalStatus status={view.removal.status} />
      <Nearby rows={nearby} scores={nearbyScores} locale={locale} now={now} wide={false} className="px-gutter-phone pt-7" />
      <footer className="mt-auto flex flex-col gap-1 px-gutter-phone pt-[18px] pb-6 text-caption text-muted">
        <FootLinks place={place} />
      </footer>
    </div>
  );
}

/**
 * The desktop's page (DeskPlace.dc.html, with the no-reviews state of PlaceNew.dc.html): the way
 * back, then a column with the name, the panel, the reviews and the places nearby, and a rail 320 px
 * wide with Rate this place, the actions, the map, the facts, Suggest a fix and the attribution.
 */
function DeskPlace({ view }: { view: View }): JSX.Element {
  const { place, actions, state, nearby, nearbyScores, locale, now } = view;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide />
      <div className="flex items-start gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-[26px]">
          <DeskHeader {...view} />
          <ScorePanel name={place.name} wide shown={view.shown} onRetry={view.retry} />
          <PlaceReviews view={view} wide />
          <RemovalStatus status={view.removal.status} />
          <Nearby rows={nearby} scores={nearbyScores} locale={locale} now={now} wide />
        </div>
        <aside aria-label={copy.place.railLabel} className="flex w-rail min-w-0 shrink-0 flex-col gap-4">
          <RateButton />
          <RailActions actions={actions} />
          <MissingDetails place={place} actions={actions} state={state} />
          <PlaceMap place={place} className="h-[220px] rounded-panel" />
          <Facts place={place} now={now} locale={locale} />
          <div className="flex flex-col gap-0.5 border-t-token border-line pt-2 text-caption text-muted">
            <FootLinks place={place} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The closest places to `place`, not counting itself, as far as a city reaches. */
function nearbyOf(indexes: Indexes, place: Place): PlaceDistance[] {
  return indexes
    .near(place.lat, place.lon, config.defaultCity.radiusKm, NEARBY_COUNT + 1)
    .filter((row) => row.place.address !== place.address)
    .slice(0, NEARBY_COUNT);
}

/** A place's page, once the place is found. */
function PlaceView({ place, indexes }: { place: Place; indexes: Indexes }): JSX.Element {
  useDocumentTitle(copy.titles.place(place.name));
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const state = useMemo(() => openState(place, now), [place, now]);
  const actions = useMemo(() => actionsOf(place), [place]);
  const nearby = useMemo(() => nearbyOf(indexes, place), [indexes, place]);
  // The place's score and reviews from the view on screen; the places nearby ask for theirs in one go.
  const { score, reviews, read, view: scoresView, state: scoresState } = useScore(place.address);
  const { refresh } = useScoreActions();
  // The review of the person signed in, which the page shows on its own (ruling R15). While a session
  // this tab kept is restored, theirs is known from it, so that it does not move once they are signed in.
  const me = useOwnPubkey();
  const mine = me === undefined ? undefined : reviews.find((review) => review.reviewer === me);
  const removal = useRemoveReview(place, mine);
  // Its Rate this place, for the focus once the person's review, the only one, is removed.
  const rate = useRef<HTMLAnchorElement>(null);
  const { scores: nearbyScores } = useListScores(nearby);
  // How far away is said only from where the device says the person is. From the default city, or a
  // town they picked, it would be how far the place is from somewhere they may not be.
  const away = here.source === "device" ? formatDistance(distanceKm(here.lat, here.lon, place.lat, place.lon), locale) : "";
  const view: View = {
    place,
    kindAway: copy.place.kindAway(placeKindLabel(place.category, place.cuisine), away),
    state,
    // The phone's line is its own; the desktop's sits inside one that dots join (DeskPlace.dc.html).
    line: openLine(state, locale, wide ? "placeInline" : "place"),
    actions,
    shown: seenBy(shownScore(score, reviews.length > 0, scoresState, read, scoresView), score, mine),
    score,
    mine,
    removal,
    scoresView,
    scoresState,
    nearby,
    nearbyScores,
    retry: refresh,
    locale,
    now,
  };
  return <RateButtonRef value={rate}>{wide ? <DeskPlace view={view} /> : <PhonePlace view={view} />}</RateButtonRef>;
}

/**
 * A place's page (screens 6 and 7, D2), at `/place/:d`: its score from the view on screen (House
 * picks, or My circle) and the reviews behind it (Place.dc.html), or, while nobody has reviewed it, its no-reviews state (PlaceNew.dc.html),
 * where the facts carry the page. A `d` the places do not have is a place that came off the list,
 * said once the latest list is in.
 *
 * At `/place/:d/review`, the form that reviews it, given the place: on a phone a page of its own, in
 * place of the place's (Review.dc.html); on a desktop a dialog over it (DeskReview.dc.html), the page
 * staying as it was, so the focus can go back to what opened the dialog.
 */
export function PlacePage(): JSX.Element {
  const { d = "" } = useParams();
  const indexes = useIndexes();
  const place = indexes?.byD.get(d);
  const wide = useWide();
  const review = useOutlet(place);
  if (place === undefined || indexes === undefined) return <NotListedOrLoading />;
  // The form is in the same place in the tree on a phone (its own page, in place of the place's) and
  // on a desktop (a dialog over it): crossing 900 px lays it out the other way without starting it
  // again, so a post under way goes on (src/review/usePost.ts).
  return (
    <>
      {(review === null || wide) && <PlaceView key={place.address} place={place} indexes={indexes} />}
      {review}
    </>
  );
}
