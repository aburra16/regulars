import { type JSX, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { stepsBackToExplore } from "../explore/returnPoint.ts";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type LngLat, type Pin } from "../map/BaseMap.tsx";
import { distanceKm, formatDistance } from "../places/distance.ts";
import { type OpenState, openLine, openState } from "../places/hours.ts";
import type { Indexes, PlaceDistance } from "../places/indexes.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { usePlaces } from "../places/store.tsx";
import { useIndexes } from "../places/useIndexes.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { Attribution } from "../ui/Attribution.tsx";
import { PageMessage, primaryButton } from "../ui/Banner.tsx";
import { BackIcon, SavedIcon } from "../ui/icons.tsx";
import { KindTile } from "../ui/KindTile.tsx";
import { PlaceRow } from "../ui/PlaceRow.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { scriptLang } from "../ui/scriptLang.ts";
import { actionsOf, PhoneActions, type PlaceActions, RailActions } from "./Actions.tsx";
import { Facts } from "./Facts.tsx";
import { osmNoteUrl, osmUrl } from "./osmLinks.ts";
import { RateButton, ScorePanel } from "./ScorePanel.tsx";

/** How close the map is: a street and the blocks around it. */
const MAP_ZOOM = 16;

/** How many places "Nearby" lists. */
const NEARBY_COUNT = 3;

/** What a screen reader hears after a link's words when the link opens a new tab. */
const NewTab = () => (
  <>
    {" "}
    <span className="sr-only">{copy.common.newTab}</span>
  </>
);

/** A link that leaves the app, to OpenStreetMap: a new tab, telling it nothing of where it came from. */
function OutLink({ href, className, children }: { href: string; className: string; children: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <NewTab />
    </a>
  );
}

/**
 * The way back: the page the person came from, when they came from one in the app; Explore when
 * the place was the first page opened (a shared link). On a phone it is the arrow alone
 * (PlaceNew.dc.html); on a desktop the arrow and its words (DeskPlace.dc.html).
 */
function BackLink({ wide }: { wide: boolean }): JSX.Element {
  const navigate = useNavigate();
  const { key } = useLocation();
  const inApp = key !== "default";
  const words = inApp ? copy.place.back : copy.place.backHome;
  return (
    <Link
      to="/"
      aria-label={wide ? undefined : words}
      onClick={(event) => {
        if (!inApp || !isPlainClick(event)) return;
        event.preventDefault();
        void navigate(-1);
      }}
      className={
        wide
          ? "inline-flex min-h-touch items-center gap-1.5 self-start text-[15px] font-semibold text-ink no-underline hover:text-accent"
          : "flex size-11 items-center justify-center rounded-full text-ink"
      }
    >
      <BackIcon size={wide ? 18 : 22} />
      {wide && words}
    </Link>
  );
}

/** The bookmark at the top right of a phone's page. Saving needs sign in, which can come back here. */
function SaveLink(): JSX.Element {
  const location = useLocation();
  return (
    <Link to="/signin" state={{ from: location }} aria-label={copy.place.save} className="flex size-11 items-center justify-center text-ink">
      <SavedIcon size={22} />
    </Link>
  );
}

/**
 * Whether the place is open, as the page says it (Place.dc.html): "Open now" or "Closed" in bold,
 * then the rest in grey ("· closes 10 pm"); "Hours not listed" in grey. Hours the app cannot read
 * are the text as written, which can be any length: one line here, cut off, and the whole of it in
 * the facts.
 */
function OpenLine({ state, line }: { state: OpenState; line: string }): JSX.Element {
  if (state.kind === "unknown") return <span className="text-muted">{line}</span>;
  if (state.kind === "unparsed") {
    return (
      <span title={line} className="block truncate text-muted">
        {line}
      </span>
    );
  }
  const split = line.indexOf(" · ");
  const lead = split === -1 ? line : line.slice(0, split);
  return (
    <>
      <span className="font-bold text-ink">{lead}</span>
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
    <h1 lang={scriptLang(name)} dir="auto" className={`m-0 min-w-0 font-display font-extrabold wrap-break-word ${className}`}>
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
        <OpenLine state={state} line={line} />
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
              {" · "}
              <OpenLine state={state} line={line} />
            </>
          )}
        </div>
        {unread && (
          <div className="min-w-0 text-body leading-[normal]">
            <OpenLine state={state} line={line} />
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

/** The place on a map that does not move: its pin chosen, close in, with the map's attribution on it. */
function PlaceMap({ place, className }: { place: Place; className: string }): JSX.Element {
  const center = useMemo<LngLat>(() => [place.lon, place.lat], [place.lon, place.lat]);
  const pins = useMemo<Pin[]>(
    () => [{ address: place.address, lat: place.lat, lon: place.lon, name: place.name, category: place.category }],
    [place],
  );
  return <BaseMap center={center} zoom={MAP_ZOOM} interactive={false} pins={pins} selected={place.address} className={className} />;
}

/**
 * The place's own picture, when the details have one at an https address. It is decoration (the
 * name is the heading), loaded only as it nears the screen, and the server it comes from is not
 * told which page asked for it. A picture that does not load leaves no gap.
 */
function Picture({ src, frame, height }: { src: string; frame?: string; height: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className={frame}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`block w-full rounded-panel object-cover ${height}`}
      />
    </div>
  );
}

/** The place's picture, when it has one at an https address: nothing at any other. */
const pictureOf = (place: Place): string | undefined => (place.image?.startsWith("https://") ? place.image : undefined);

/** The places closest to this one, as compact rows, each with how far it is from here. Nothing when there are none. */
function Nearby({
  rows,
  locale,
  now,
  wide,
  className = "",
}: {
  rows: PlaceDistance[];
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
            <PlaceRow place={place} km={km} from="place" locale={locale} now={now} />
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
      <div className="flex flex-wrap items-baseline gap-x-1">
        <Attribution kind="details" />
        <Link to="/about" className="font-semibold text-ink underline hover:text-accent">
          {copy.place.aboutData}
        </Link>
      </div>
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
  nearby: PlaceDistance[];
  locale: string;
  now: Date;
}

/** The phone's page (PlaceNew.dc.html; the shared parts as Place.dc.html draws them). */
function PhonePlace({ view }: { view: View }): JSX.Element {
  const { place, actions, state, nearby, locale, now } = view;
  const picture = pictureOf(place);
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-3.5">
        <BackLink wide={false} />
        <SaveLink />
      </div>
      <PhoneHeader {...view} />
      <div className="px-gutter-phone pt-[18px]">
        <ScorePanel name={place.name} wide={false} />
      </div>
      <div className="flex flex-col gap-2 px-gutter-phone pt-4">
        <PhoneActions actions={actions} />
        <MissingDetails place={place} actions={actions} state={state} />
      </div>
      {picture !== undefined && <Picture src={picture} frame="px-gutter-phone pt-4" height="h-[150px]" />}
      <div className="px-gutter-phone pt-4">
        <PlaceMap place={place} className="h-[150px] rounded-panel" />
      </div>
      <div className="px-gutter-phone pt-4">
        <Facts place={place} now={now} locale={locale} />
      </div>
      <Nearby rows={nearby} locale={locale} now={now} wide={false} className="px-gutter-phone pt-7" />
      <footer className="mt-auto flex flex-col gap-1 px-gutter-phone pt-[18px] pb-6 text-caption text-muted">
        <FootLinks place={place} />
      </footer>
    </div>
  );
}

/**
 * The desktop's page (DeskPlace.dc.html, with the no-reviews state of PlaceNew.dc.html): the way
 * back, then a column with the name, the panel and the places nearby, and a rail 320 px wide with
 * Rate this place, the actions, the map, the facts, Suggest a fix and the attribution.
 */
function DeskPlace({ view }: { view: View }): JSX.Element {
  const { place, actions, state, nearby, locale, now } = view;
  const picture = pictureOf(place);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide />
      <div className="flex items-start gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-[26px]">
          <DeskHeader {...view} />
          <ScorePanel name={place.name} wide />
          <Nearby rows={nearby} locale={locale} now={now} wide />
        </div>
        <aside className="flex w-rail min-w-0 shrink-0 flex-col gap-4">
          <RateButton />
          <RailActions actions={actions} />
          <MissingDetails place={place} actions={actions} state={state} />
          {picture !== undefined && <Picture src={picture} height="h-[220px]" />}
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
  const away = formatDistance(distanceKm(here.lat, here.lon, place.lat, place.lon), locale);
  const view: View = {
    place,
    kindAway: copy.place.kindAway(placeKindLabel(place.category, place.cuisine), away),
    state,
    line: openLine(state, locale, "place"),
    actions,
    nearby,
    locale,
    now,
  };
  return wide ? <DeskPlace view={view} /> : <PhonePlace view={view} />;
}

/**
 * A place that is not on the list: it came off the map at the monthly refresh, or the link is
 * wrong. The way back goes to the Explore the person left, when there is one behind this page.
 */
function NotListed(): JSX.Element {
  useDocumentTitle(copy.titles.notListed);
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-gutter-phone py-16 text-center wide:px-gutter-desktop">
      <h1 className="m-0 font-display text-h2 font-bold">{copy.place.noLongerListed}</h1>
      <p className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">{copy.place.noLongerListedDetail}</p>
      <Link
        to="/"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          const steps = stepsBackToExplore();
          if (steps === undefined) return;
          event.preventDefault();
          void navigate(steps);
        }}
        className={`${primaryButton} mt-2`}
      >
        {copy.place.backToExplore}
      </Link>
    </div>
  );
}

/**
 * A place's page (screens 6 and 7, D2), at `/place/:d`. Before sign in nobody's reviews can be
 * shown, so every place is in its no-reviews state (PlaceNew.dc.html): the facts carry the page.
 * A `d` the places do not have is a place that came off the list, said once the latest list is in.
 */
export function PlacePage(): JSX.Element {
  const { d = "" } = useParams();
  const indexes = useIndexes();
  const { source, error } = usePlaces();
  const place = indexes?.byD.get(d);
  if (place !== undefined && indexes !== undefined) return <PlaceView key={place.address} place={place} indexes={indexes} />;
  // The places on screen are the ones saved on this device, and the latest, still on its way, may have it.
  if (indexes === undefined || (source === "cache" && error === undefined)) {
    return <PageMessage>{copy.load.loading}</PageMessage>;
  }
  return <NotListed />;
}
