import { type JSX, useId } from "react";
import { useNavigate } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { useListScores } from "../score/useListScores.ts";
import { PlaceRow } from "../ui/PlaceRow.tsx";
import type { PlaceElsewhere, TownFound } from "./useBeyond.ts";

/*
 * What the search finds beyond the places near (the towns brief): the towns the words name, above
 * the places near, and the places farther away whose names have them, below. The phone's page and
 * the desktop's results both show them, from `useBeyond`.
 */

/** What a key of a town's row is: its GeoNames id, or for a town of a locality, its name, region and country. */
const townKey = ({ city }: TownFound) => (city.geonameId === undefined ? `${city.name}|${city.region ?? ""}|${city.country}` : `geonames:${city.geonameId}`);

/**
 * The towns the words name, under the heading "Towns": a row for each, "Prague, Czechia · 42 places",
 * in the town picker's style, the text in line with the heading. Tapping one does what picking it in
 * the picker does (`Here.pickCity`: every screen moves there, and this device keeps it), and opens
 * Explore at the places near it, where a pick from the phone's picker lands; the words stay with the
 * search, in the history behind. Nothing when no town matches.
 */
export function TownsFound({ towns, className = "" }: { towns: TownFound[]; className?: string }): JSX.Element | null {
  const here = useHere();
  const navigate = useNavigate();
  const headingId = useId();
  if (towns.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-1 ${className}`}>
      <h2 id={headingId} className="m-0 text-body font-bold">
        {copy.search.townsHeading}
      </h2>
      {/* The rows reach 16 px past the text on each side, as the picker's do, so the text is in line with the heading. */}
      <ul role="list" className="-mx-4 my-0 flex list-none flex-col p-0">
        {towns.map((found) => (
          <li key={townKey(found)}>
            <button
              type="button"
              aria-label={copy.search.townRowName(found.where, found.city.count)}
              onClick={() => {
                here.pickCity(found.city);
                void navigate("/");
              }}
              className="flex min-h-touch w-full cursor-pointer items-center rounded-button border-0 bg-transparent px-4 py-2 text-left text-body font-semibold text-ink hover:bg-surface"
            >
              <span>
                {found.where}
                <span className="font-normal text-muted">
                  {copy.common.joiner}
                  {copy.location.count(found.city.count)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The places farther away whose names have the words, under the heading "Elsewhere", below the places
 * near: each a row that says where it is, its town and country, in place of how far, with its score,
 * and opens its page. The filters and the sort are for the places near: when one is on (`unfiltered`),
 * a quiet line says so. Nothing when there are none.
 */
export function Elsewhere({
  rows,
  near,
  unfiltered,
  locale,
  now,
  className = "",
}: {
  rows: PlaceElsewhere[];
  /** Where the places near are near: "Funchal", or "you". */
  near: string;
  unfiltered: boolean;
  locale: string;
  now: Date;
  className?: string;
}): JSX.Element | null {
  const headingId = useId();
  // Their scores, asked for in one go.
  const { scores } = useListScores(rows);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-1 ${className}`}>
      <h2 id={headingId} className="m-0 text-body font-bold">
        {copy.search.elsewhereHeading}
      </h2>
      {unfiltered && <p className="m-0 text-secondary leading-[1.4] text-muted">{copy.search.elsewhereUnfiltered(near)}</p>}
      <ul role="list" className="m-0 flex list-none flex-col p-0">
        {rows.map(({ place, km, where }) => (
          <li key={place.address}>
            <PlaceRow place={place} km={km} where={where} score={scores.of(place.address)} locale={locale} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}
