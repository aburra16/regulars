import { type JSX, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { openState } from "../places/hours.ts";
import { type Chain, chainSlug, type PlaceDistance } from "../places/indexes.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { ChevronRightIcon } from "./icons.tsx";
import { KindTile } from "./KindTile.tsx";
import { scriptLang } from "./scriptLang.ts";

/**
 * What most of a chain's places are, in words, and the category that gives its tile. When two
 * kinds are as common, the one the nearest place is wins.
 */
export function commonKind(chain: Chain, nearby: readonly PlaceDistance[]): { label: string; category: string } {
  const rank = new Map<Place, number>(nearby.map((row, i) => [row.place, i]));
  const nearestFirst = [...chain.places].sort(
    (a, b) => (rank.get(a) ?? nearby.length) - (rank.get(b) ?? nearby.length),
  );
  const counts = new Map<string, { category: string; count: number }>();
  for (const place of nearestFirst) {
    const label = placeKindLabel(place.category, place.cuisine);
    const seen = counts.get(label);
    if (seen === undefined) counts.set(label, { category: place.category, count: 1 });
    else seen.count += 1;
  }
  let best: { label: string; category: string } | undefined;
  let most = 0;
  for (const [label, { category, count }] of counts) {
    if (count > most) {
      best = { label, category };
      most = count;
    }
  }
  return best ?? { label: "", category: "" };
}

/** How the two variants look: the card of Explore (Main.dc.html) and the row of the search results (Search.dc.html). */
const LOOK = {
  card: {
    link: "gap-3.5 rounded-card p-3.5",
    body: "gap-1.5",
    tile: { size: "card", tone: "ground" },
    name: "text-card-title",
  },
  row: {
    link: "gap-3 border-b-token border-line py-3.5",
    body: "gap-1",
    tile: { size: "row", tone: "ink" },
    name: "text-[18px]",
  },
} as const;

type ChainCardProps = {
  chain: Chain;
  /** The chain's places that are in the list, nearest first. */
  nearby: PlaceDistance[];
  locale: string;
  /** The card of the pin chosen on the map: a heavier edge in the ink colour, as a place's card has (DeskExplore.dc.html). */
  selected?: boolean;
  /** The card docked over the phone's map: white, with no edge but a shadow, as a place's card there. */
  onMap?: boolean;
} & (
  | { variant?: "card"; now?: undefined }
  /** The row says how many of the places near are open, so it needs the time. */
  | { variant: "row"; now: Date }
);

/**
 * Places that share a name, as one entry in a list: what the chain is, how many locations it has and
 * how many of them are near, and a chevron, since it opens a list of them.
 *
 * - `card` (Main.dc.html): tinted, with how far the closest of them is ("3 locations, the closest 0.6 mi away").
 * - `row` (Search.dc.html): a row of the results, its tile dark, with how many are open ("3 locations, 2 open now").
 *
 * Neither says "near you": the distance is from where the list is near, which is the person only when
 * the "Near …" control says so.
 */
/** The edge and ground of the card variant: tinted with a line, the ink edge when chosen, white with a shadow over the map. */
function cardEdge(selected: boolean, onMap: boolean): string {
  if (onMap) return "bg-ground shadow-card-over-map";
  return selected ? "border-2 border-ink bg-surface" : "border-token border-line bg-surface";
}

export function ChainCard({
  chain,
  nearby,
  locale,
  variant = "card",
  now,
  selected = false,
  onMap = false,
}: ChainCardProps): JSX.Element {
  const id = useId();
  const kind = useMemo(() => commonKind(chain, nearby), [chain, nearby]);
  const closest = Math.min(...nearby.map((row) => row.km));
  const openNow = useMemo(
    () => (now === undefined ? 0 : nearby.filter((row) => openState(row.place, now).kind === "open").length),
    [nearby, now],
  );
  const look = LOOK[variant];

  return (
    <Link
      to={`/chain/${chainSlug(chain)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-kind ${id}-near`}
      className={`flex text-ink no-underline ${look.link} ${variant === "card" ? cardEdge(selected, onMap) : ""}`}
    >
      <KindTile category={kind.category} size={look.tile.size} tone={onMap ? "surface" : look.tile.tone} />
      <div className={`flex min-w-0 flex-1 flex-col ${look.body}`}>
        <div className="flex items-start justify-between gap-2.5">
          <span
            id={`${id}-name`}
            lang={scriptLang(chain.name)}
            dir="auto"
            className={`line-clamp-2 min-w-0 font-display leading-[1.2] font-bold wrap-break-word ${look.name}`}
          >
            {chain.name}
          </span>
          <ChevronRightIcon size={20} className="mt-0.5 shrink-0" />
        </div>
        <div id={`${id}-kind`} className="text-secondary text-muted">
          {copy.explore.chainKind(kind.label, chain.places.length)}
        </div>
        <div id={`${id}-near`} className="text-secondary font-bold">
          {variant === "row"
            ? copy.search.chainNearbyOpen(nearby.length, openNow)
            : copy.explore.chainNearby(nearby.length, formatDistance(closest, locale))}
        </div>
      </div>
    </Link>
  );
}
