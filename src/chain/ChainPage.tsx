import { type JSX, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type Pin } from "../map/BaseMap.tsx";
import { distanceKm } from "../places/distance.ts";
import { type Chain, chainSlug, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { Attribution } from "../ui/Attribution.tsx";
import { BackLink } from "../ui/BackLink.tsx";
import { commonKind } from "../ui/ChainCard.tsx";
import { KindTile } from "../ui/KindTile.tsx";
import { NotListedOrLoading } from "../ui/NotListed.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { type ShownPage, shownMemory, shownPageOf, useShownCount } from "../ui/shown.ts";
import { fitView } from "./fit.ts";
import { LocationRow } from "./LocationRow.tsx";

/** How many locations "Show more" adds, and how many more than the nearby ones "Show all" shows at first. */
const PAGE_SIZE = 50;

/** How many locations are listed when none is near: the nearest few. */
const NEAREST_COUNT = 3;

/** Every location of the chain, nearest to `here` first. */
function byDistance(chain: Chain, lat: number, lon: number): PlaceDistance[] {
  return chain.places
    .map((place) => ({ place, km: distanceKm(lat, lon, place.lat, place.lon) }))
    .sort((a, b) => a.km - b.km);
}

/** The chain's name, marked with its script and free to wrap anywhere: a long name stays inside the page. */
function Name({ name, className }: { name: string; className: string }): JSX.Element {
  return (
    <h1 lang={scriptLang(name)} dir="auto" className={`m-0 min-w-0 font-display font-extrabold wrap-break-word ${className}`}>
      {name}
    </h1>
  );
}

/** What the page works out of the chain and where the person is. */
interface ChainInfo {
  chain: Chain;
  /** Every location, nearest first. */
  all: PlaceDistance[];
  /** How many of them are within a city's reach of here: the ones "near you". */
  near: number;
  /** What the list shows at first: the near ones, or the nearest few when none is near. */
  first: number;
  /** The kind of most of the chain's places, in words, and the category of its tile. */
  kind: { label: string; category: string };
  locale: string;
  now: Date;
}

/** The tinted box under the header (Chain.dc.html): each location stands on its own. */
function EachScored(): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5 rounded-panel bg-surface px-[18px] py-4">
      <div className="text-body font-bold">{copy.chain.eachScored}</div>
      <div className="text-secondary leading-[1.45] text-muted">{copy.chain.eachScoredDetail}</div>
    </section>
  );
}

/** Where each page of a chain's list keeps how many locations it has shown. */
const shownIn = (first: number) => shownMemory("regulars.chain.shown", first);

/**
 * The locations: the near ones, or the nearest few when none is, and below them a button for all of
 * them. The rest come fifty at a time, the way the search results do, with the focus moved to the
 * first one that is new. `page` is this page of the history and its list, so Back to it shows as many
 * as it had.
 */
function Locations({ view, page, showMap }: { view: ChainInfo; page: ShownPage; showMap: boolean }): JSX.Element {
  const { all, near, first, locale, now } = view;
  const memory = useMemo(() => shownIn(first), [first]);
  const [count, setCount] = useShownCount(memory, page, all.length);
  const list = useRef<HTMLUListElement>(null);
  const focusAt = useRef<number | null>(null);

  useEffect(() => {
    if (focusAt.current === null) return;
    list.current?.children[focusAt.current]?.querySelector("a")?.focus();
    focusAt.current = null;
  }, [count]);

  const expanded = count > first;
  const heading = expanded ? copy.pages.chain : near > 0 ? copy.chain.near : copy.chain.nearest;
  const reveal = (to: number) => {
    focusAt.current = count;
    setCount(Math.min(all.length, to));
  };

  return (
    <section className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 className="m-0 font-display text-h2 font-bold wide:text-[26px]">{heading}</h2>
        {showMap && near > 0 && (
          <Link to="/map" className="inline-flex min-h-touch items-center text-[15px] font-bold text-accent no-underline">
            {copy.chain.seeOnMap}
          </Link>
        )}
      </div>
      <ul ref={list} role="list" className="m-0 flex list-none flex-col border-b-token border-line p-0">
        {all.slice(0, count).map(({ place, km }) => (
          <li key={place.address}>
            <LocationRow place={place} km={km} locale={locale} now={now} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2.5 pt-5">
        {count < all.length && (
          <button
            type="button"
            onClick={() => reveal(expanded ? count + PAGE_SIZE : first + PAGE_SIZE)}
            className="h-13 cursor-pointer rounded-button border-token border-line-strong bg-ground px-6 font-text text-[15px] font-bold text-ink"
          >
            {expanded ? copy.explore.showMore : copy.chain.showAll(all.length)}
          </button>
        )}
        <p className="m-0 text-caption leading-[1.45] text-muted">{copy.chain.grouped}</p>
      </div>
    </section>
  );
}

/** The foot of the page: where the details come from, with a link to say more. */
function Credit(): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1 text-caption text-muted">
      <Attribution kind="details" />
      <Link to="/about" className="font-semibold text-ink underline hover:text-accent">
        {copy.place.aboutData}
      </Link>
    </div>
  );
}

/**
 * The listed locations on a map that does not move (the rail's): each a ring, the nearest chosen,
 * the view fitted to them all.
 */
function ChainMap({ view, listed, className }: { view: ChainInfo; listed: PlaceDistance[]; className: string }): JSX.Element {
  const { chain } = view;
  const mapView = useMemo(() => fitView(listed.map(({ place }) => place)), [listed]);
  const pins = useMemo<Pin[]>(
    () =>
      listed.map(({ place }) => ({
        address: place.address,
        lat: place.lat,
        lon: place.lon,
        name: place.name,
        category: place.category,
      })),
    [listed],
  );
  return (
    <BaseMap
      center={mapView.center}
      zoom={mapView.zoom}
      interactive={false}
      label={copy.chain.mapLabel(chain.name)}
      pins={pins}
      selected={listed[0]?.place.address}
      className={className}
    />
  );
}

/** The phone's page (Chain.dc.html): the way back, the header, the box, the locations and the credit. */
function PhoneChain({ view, page }: { view: ChainInfo; page: ShownPage }): JSX.Element {
  const { chain, near, kind } = view;
  return (
    <div className="flex flex-1 flex-col">
      <div className="px-3 pt-3.5">
        <BackLink wide={false} />
      </div>
      <section className="flex min-w-0 flex-col gap-2.5 px-gutter-phone pt-1.5">
        <KindTile category={kind.category} size="page" tone="ink" />
        <Name name={chain.name} className="text-display-phone leading-[1.08] tracking-display" />
        <div className="text-[15px] text-muted">{copy.chain.line(kind.label, chain.places.length, near)}</div>
      </section>
      <div className="px-gutter-phone pt-[18px]">
        <EachScored />
      </div>
      <div className="px-gutter-phone pt-6">
        <Locations view={view} page={page} showMap />
      </div>
      <footer className="mt-auto px-gutter-phone pt-[18px] pb-[22px]">
        <Credit />
      </footer>
    </div>
  );
}

/**
 * The desktop's page, in the pattern of DeskPlace.dc.html (the chain is not drawn for a desktop):
 * the way back, then a column with the header, the box and the locations, and a rail 320 px wide
 * with the map and the credit.
 */
function DeskChain({ view, page }: { view: ChainInfo; page: ShownPage }): JSX.Element {
  const { chain, near, kind, all, first } = view;
  // The map pins what the list shows at first, however far the person has read down it.
  const listed = useMemo(() => all.slice(0, first), [all, first]);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide />
      <div className="flex items-start gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-[26px]">
          <section className="flex min-w-0 items-start gap-[18px]">
            <KindTile category={kind.category} size="page" tone="ink" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Name name={chain.name} className="text-display-desktop leading-[1.05] tracking-[-0.025em]" />
              <div className="text-body text-muted">{copy.chain.line(kind.label, chain.places.length, near)}</div>
            </div>
          </section>
          <EachScored />
          <Locations view={view} page={page} showMap={false} />
        </div>
        <aside aria-label={copy.chain.railLabel} className="flex w-rail min-w-0 shrink-0 flex-col gap-4">
          <ChainMap view={view} listed={listed} className="h-[220px] rounded-panel" />
          <Credit />
        </aside>
      </div>
    </div>
  );
}

/** A chain's page, once the chain is found. */
function ChainView({ chain }: { chain: Chain }): JSX.Element {
  useDocumentTitle(copy.titles.chain(chain.name));
  const wide = useWide();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  const { key: historyKey } = useLocation();

  const all = useMemo(() => byDistance(chain, here.lat, here.lon), [chain, here.lat, here.lon]);
  const near = useMemo(() => all.filter((row) => row.km <= config.defaultCity.radiusKm).length, [all]);
  const kind = useMemo(() => commonKind(chain, all.slice(0, Math.max(near, NEAREST_COUNT))), [chain, all, near]);
  const first = Math.min(all.length, near > 0 ? near : NEAREST_COUNT);
  const view: ChainInfo = { chain, all, near, first, kind, locale, now };

  // A new town is a new list, which starts from its first locations; Back to a page of the history finds this one as it was.
  const list = `${chainSlug(chain)}|${here.lat}|${here.lon}`;
  const page = shownPageOf(historyKey, list);
  return wide ? <DeskChain key={`${historyKey}|${list}`} view={view} page={page} /> : <PhoneChain key={`${historyKey}|${list}`} view={view} page={page} />;
}

/**
 * A chain's page (screen 5), at `/chain/:key`: the places in one country that share a name, the ones
 * near the person listed by address, each scored on its own. Before sign in nobody's reviews can be
 * shown, so every location says that nobody has reviewed it. A chain the list does not have is a
 * chain that came off the map, said once the latest list is in (as a place's page does).
 */
export function ChainPage(): JSX.Element {
  const { key = "" } = useParams();
  const indexes = useIndexes();
  const chain = indexes?.chainBySlug(key);
  if (chain === undefined) return <NotListedOrLoading />;
  return <ChainView key={chainSlug(chain)} chain={chain} />;
}
