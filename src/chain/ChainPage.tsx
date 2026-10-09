import { type Dispatch, type JSX, type SetStateAction, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { mapFocusOn } from "../explore/mapFocus.ts";
import { useHere } from "../location/useLocation.ts";
import { BaseMap, type Pin } from "../map/BaseMap.tsx";
import { distanceKm } from "../places/distance.ts";
import { type Chain, chainSlug, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { formatScore } from "../score/score.ts";
import { type ListScores, useListScores } from "../score/useListScores.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { BackLink } from "../ui/BackLink.tsx";
import { commonKind } from "../ui/ChainCard.tsx";
import { DetailsCredit } from "../ui/DetailsCredit.tsx";
import { KindTile } from "../ui/KindTile.tsx";
import { NotListedOrLoading } from "../ui/NotListed.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { type ShownPage, shownMemory, shownPageOf, useShownCount } from "../ui/shown.ts";
import { fitView } from "./fit.ts";
import { LocationRow } from "./LocationRow.tsx";

/**
 * How many of the locations near here the page lists before "Show all": a chain with many in a city
 * (a coffee house on every block) is as long as a screen's worth, and no more.
 */
const NEAR_COUNT_MAX = 50;

/** How many locations are listed when none is near: the nearest few. */
const NEAREST_COUNT = 3;

/**
 * The most rows the page ever draws. "Show all" shows every location up to this many, nearest first,
 * in one list with no more paging; a chain with more is shown to this many, and its button says so.
 */
const ROWS_MAX = 500;

/** Every location of the chain, nearest to `here` first. */
function byDistance(chain: Chain, lat: number, lon: number): PlaceDistance[] {
  return chain.places
    .map((place) => ({ place, km: distanceKm(lat, lon, place.lat, place.lon) }))
    .sort((a, b) => a.km - b.km);
}

/** The chain's name, marked with its script and free to wrap anywhere: a long name stays inside the page. */
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

/** What the page works out of the chain and where the person is. */
interface ChainInfo {
  chain: Chain;
  /** The locations the page can list, nearest first: all of them, to `ROWS_MAX`. */
  listed: PlaceDistance[];
  /** How many of the chain's locations are within a city's reach of here: the ones "near Funchal". */
  near: number;
  /** Where here is, as the "Near …" control names it: a town, or "you" when it is the device. */
  where: string;
  /** How many locations the list shows at first: those near, to `NEAR_COUNT_MAX`, or the nearest few when none is near. */
  first: number;
  /** The kind of most of the chain's places, in words, and the category of its tile. */
  kind: { label: string; category: string };
  locale: string;
  now: Date;
}

/** How many locations the list shows, and how to change it; and the scores of those it asked for. */
interface Shown {
  count: number;
  setCount: Dispatch<SetStateAction<number>>;
  scores: ListScores;
}

/**
 * What the view on screen rates the locations near here, said after the box's line (Chain.dc.html):
 * the house, or the person's circle. The lowest and the highest score when two or more have one, the
 * score when one does, and nothing when none does. A range, never an average: each location is its own.
 */
function viewRange(info: ChainInfo, scores: ListScores): string | undefined {
  const near = info.listed.slice(0, info.near).flatMap(({ place }) => {
    const shown = scores.of(place.address);
    return shown.kind === "scored" ? [shown.score] : [];
  });
  if (near.length === 0) return undefined;
  const circle = scores.view === "circle";
  if (near.length === 1) {
    const one = formatScore(near[0]!);
    return circle ? copy.chain.circleOne(one, info.where) : copy.chain.houseOne(one, info.where);
  }
  const [low, high] = [formatScore(Math.min(...near)), formatScore(Math.max(...near))];
  return circle ? copy.chain.circleRange(low, high, info.where) : copy.chain.houseRange(low, high, info.where);
}

/** The tinted box under the header (Chain.dc.html): each location stands on its own, and what the view rates those near. */
function EachScored({ range }: { range: string | undefined }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5 rounded-panel bg-surface px-[18px] py-4">
      <div className="text-body font-bold">{copy.chain.eachScored}</div>
      <div className="text-secondary leading-[1.45] text-muted">
        {copy.chain.eachScoredDetail}
        {range !== undefined && ` ${range}`}
      </div>
    </section>
  );
}

/**
 * The locations: those near here, or the nearest few when none is, and below them a button for all
 * of them, which shows every one at once, the focus moved to the first that is new.
 */
function Locations({ info, shown, showMap }: { info: ChainInfo; shown: Shown; showMap: boolean }): JSX.Element {
  const { chain, listed, near, where, first, locale, now } = info;
  const { count, setCount, scores } = shown;
  const list = useRef<HTMLUListElement>(null);
  const focusAt = useRef<number | null>(null);

  useEffect(() => {
    if (focusAt.current === null) return;
    list.current?.children[focusAt.current]?.querySelector("a")?.focus();
    focusAt.current = null;
  }, [count]);

  const expanded = count > first;
  const heading = expanded ? copy.pages.chain : near > 0 ? copy.chain.near(where) : copy.chain.nearest;
  const showAll = () => {
    focusAt.current = count;
    setCount(listed.length);
  };

  return (
    <section className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 className="m-0 font-display text-h2 font-bold wide:text-[26px]">{heading}</h2>
        {showMap && near > 0 && (
          // The map, at the nearest location, with the chain's pin chosen.
          <Link
            to="/map"
            state={mapFocusOn(listed[0]!.place)}
            className="inline-flex min-h-touch items-center text-[15px] font-bold text-accent underline"
          >
            {copy.chain.seeOnMap}
          </Link>
        )}
      </div>
      <ul ref={list} role="list" className="m-0 flex list-none flex-col border-b-token border-line p-0">
        {listed.slice(0, count).map(({ place, km }) => (
          <li key={place.address}>
            <LocationRow place={place} km={km} score={scores.of(place.address)} locale={locale} now={now} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2.5 pt-5">
        {count < listed.length && (
          <button
            type="button"
            onClick={showAll}
            className="h-13 cursor-pointer rounded-button border-token border-line-strong bg-ground px-6 font-text text-[15px] font-bold text-ink"
          >
            {chain.places.length > listed.length ? copy.chain.showNearest(listed.length) : copy.chain.showAll(listed.length)}
          </button>
        )}
        <p className="m-0 text-caption leading-[1.45] text-muted">{copy.chain.grouped}</p>
      </div>
    </section>
  );
}

/**
 * The locations the list shows, on a map that does not move (the rail's): each a ring, or a pill with
 * its score, the nearest chosen, the view fitted to all of them. When the list shows more, so does the map.
 */
function ChainMap({
  chain,
  shown,
  scores,
  className,
}: {
  chain: Chain;
  shown: PlaceDistance[];
  scores: ListScores;
  className: string;
}): JSX.Element {
  const mapView = useMemo(() => fitView(shown.map(({ place }) => place)), [shown]);
  const pins = useMemo<Pin[]>(
    () =>
      shown.map(({ place }) => {
        const score = scores.of(place.address);
        return {
          address: place.address,
          lat: place.lat,
          lon: place.lon,
          name: place.name,
          category: place.category,
          ...(score.kind === "scored" ? { label: formatScore(score.score) } : {}),
        };
      }),
    [shown, scores],
  );
  return (
    <BaseMap
      center={mapView.center}
      zoom={mapView.zoom}
      interactive={false}
      label={copy.chain.mapLabel(chain.name)}
      pins={pins}
      selected={shown[0]?.place.address}
      className={className}
    />
  );
}

/** The phone's page (Chain.dc.html): the way back, the header, the box, the locations and the credit. */
function PhoneChain({ info, shown }: { info: ChainInfo; shown: Shown }): JSX.Element {
  const { chain, near, where, kind } = info;
  return (
    <div className="flex flex-1 flex-col">
      <div className="px-3 pt-3.5">
        <BackLink wide={false} />
      </div>
      <section className="flex min-w-0 flex-col gap-2.5 px-gutter-phone pt-1.5">
        <KindTile category={kind.category} size="page" tone="ink" />
        <Name name={chain.name} className="text-display-phone leading-[1.08] tracking-display" />
        <div className="text-[15px] text-muted">{copy.chain.line(kind.label, chain.places.length, near, where)}</div>
      </section>
      <div className="px-gutter-phone pt-[18px]">
        <EachScored range={viewRange(info, shown.scores)} />
      </div>
      <div className="px-gutter-phone pt-6">
        <Locations info={info} shown={shown} showMap />
      </div>
      <footer className="mt-auto px-gutter-phone pt-[18px] pb-[22px]">
        <DetailsCredit />
      </footer>
    </div>
  );
}

/**
 * The desktop's page, in the pattern of DeskPlace.dc.html (the chain is not drawn for a desktop):
 * the way back, then a column with the header, the box and the locations, and a rail 320 px wide
 * with the map and the credit.
 */
function DeskChain({ info, shown }: { info: ChainInfo; shown: Shown }): JSX.Element {
  const { chain, near, where, kind, listed } = info;
  const pinned = useMemo(() => listed.slice(0, shown.count), [listed, shown.count]);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide />
      <div className="flex items-start gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-[26px]">
          <section className="flex min-w-0 items-start gap-[18px]">
            <KindTile category={kind.category} size="page" tone="ink" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Name name={chain.name} className="text-display-desktop leading-[1.05] tracking-[-0.025em]" />
              <div className="text-body text-muted">{copy.chain.line(kind.label, chain.places.length, near, where)}</div>
            </div>
          </section>
          <EachScored range={viewRange(info, shown.scores)} />
          <Locations info={info} shown={shown} showMap={false} />
        </div>
        <aside aria-label={copy.chain.railLabel} className="flex w-rail min-w-0 shrink-0 flex-col gap-4">
          <ChainMap chain={chain} shown={pinned} scores={shown.scores} className="h-[220px] rounded-panel" />
          <DetailsCredit />
        </aside>
      </div>
    </div>
  );
}

/**
 * The page's body, with how many locations it lists. That is kept with the page of the history
 * (`page`), so Back to it lists as many, and the scroll position the router restores is still on it.
 * It is the one place the count is held, since the map beside the list pins what the list shows.
 * It asks for the scores of the locations listed, and of every one near (for the box's range), in one go.
 */
function ChainBody({ info, page, wide }: { info: ChainInfo; page: ShownPage; wide: boolean }): JSX.Element {
  const memory = useMemo(() => shownMemory("regulars.chain.shown", info.first), [info.first]);
  const [count, setCount] = useShownCount(memory, page, info.listed.length);
  const asked = useMemo(() => info.listed.slice(0, Math.max(count, info.near)), [info.listed, info.near, count]);
  const { scores } = useListScores(asked);
  const shown = { count, setCount, scores };
  return wide ? <DeskChain info={info} shown={shown} /> : <PhoneChain info={info} shown={shown} />;
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
  const info = useMemo<ChainInfo>(() => {
    const listed = all.slice(0, ROWS_MAX);
    const kind = commonKind(chain, all.slice(0, Math.max(near, NEAREST_COUNT)));
    const first = Math.min(listed.length, near > 0 ? Math.min(near, NEAR_COUNT_MAX) : NEAREST_COUNT);
    return { chain, listed, near, where: here.label, first, kind, locale, now };
  }, [chain, all, near, here.label, locale, now]);

  // A new town is a new list, which starts from its first locations; Back to a page of the history finds this one as it was.
  const list = `${chainSlug(chain)}|${here.lat}|${here.lon}`;
  const page = shownPageOf(historyKey, list);
  return <ChainBody key={`${historyKey}|${list}`} info={info} page={page} wide={wide} />;
}

/**
 * A chain's page (screen 5), at `/chain/:key`: the places in one country that share a name, the ones
 * near the person listed by address, each scored on its own by House picks, and the range of those
 * scores near the person. A chain the list does not have is a chain that came off the map, said once
 * the latest list is in (as a place's page does).
 */
export function ChainPage(): JSX.Element {
  const { key = "" } = useParams();
  const indexes = useIndexes();
  const chain = indexes?.chainBySlug(key);
  if (chain === undefined) return <NotListedOrLoading />;
  return <ChainView key={chainSlug(chain)} chain={chain} />;
}
