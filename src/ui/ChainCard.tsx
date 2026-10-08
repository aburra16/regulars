import { type JSX, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
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
function commonKind(chain: Chain, nearby: readonly PlaceDistance[]): { label: string; category: string } {
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

/**
 * Places that share a name, as one card (Main.dc.html): tinted, with what the chain is, how many
 * locations it has and how many of them are near, and a chevron, since it opens a list of them.
 * `nearby` is the chain's places that are in the list, nearest first.
 */
export function ChainCard({
  chain,
  nearby,
  locale,
}: {
  chain: Chain;
  nearby: PlaceDistance[];
  locale: string;
}): JSX.Element {
  const id = useId();
  const kind = useMemo(() => commonKind(chain, nearby), [chain, nearby]);
  const closest = Math.min(...nearby.map((row) => row.km));

  return (
    <Link
      to={`/chain/${chainSlug(chain)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-kind ${id}-near`}
      className="flex gap-3.5 rounded-card border-token border-line bg-surface p-3.5 text-ink no-underline"
    >
      <KindTile category={kind.category} size="card" tone="ground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2.5">
          <span
            id={`${id}-name`}
            lang={scriptLang(chain.name)}
            dir="auto"
            className="line-clamp-2 min-w-0 font-display text-card-title leading-[1.2] font-bold wrap-break-word"
          >
            {chain.name}
          </span>
          <ChevronRightIcon size={20} className="mt-0.5 shrink-0" />
        </div>
        <div id={`${id}-kind`} className="text-secondary text-muted">
          {copy.explore.chainKind(kind.label, chain.places.length)}
        </div>
        <div id={`${id}-near`} className="text-secondary font-bold">
          {copy.explore.chainNearby(nearby.length, formatDistance(closest, locale))}
        </div>
      </div>
    </Link>
  );
}
