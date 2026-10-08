import { type JSX, useId } from "react";

import { copy } from "../copy/en.ts";
import { FAMILIES, type FamilyId } from "../places/kinds.ts";
import { Chips } from "../ui/Chips.tsx";
import { FamilyIcon } from "../ui/KindTile.tsx";
import { Switch } from "../ui/Switch.tsx";
import { useCurrentView } from "../view/ViewProvider.tsx";
import { type Sort, widestKm, withinChoices } from "./filters.ts";
import type { Order } from "./useResults.ts";

/*
 * The controls of Filters.dc.html, one for each filter, without the headings: the filters page
 * puts them in a column with its own, and the desktop's Explore (which shows them as menus) gives
 * them theirs. Each is controlled: it shows `value` and says what the person chose. Each group is
 * named by the heading that is drawn above it, `labelledBy` being that heading's id.
 */

/** What is pressed when no sort is shown: none of the three, and not a sort that can be asked for. */
const AUTO = "auto";

/**
 * How to sort: by the score of the view on screen (House picks', which needs no sign in, or My
 * circle's while it is the view), Distance and Name. With no sort chosen
 * (`value` is undefined) the page picks the order, `order`, and this shows it: Distance pressed when
 * the list is nearest first, and none pressed, with a line that says so, when it is best match
 * first. Pressing a sort chooses it, and the one that only shows the order in use too; pressing the
 * one the person chose goes back to no sort.
 */
export function SortOptions({
  value,
  order,
  onChange,
  labelledBy,
}: {
  value: Sort | undefined;
  /** The order the list is in. */
  order: Order;
  onChange(sort: Sort | undefined): void;
  labelledBy: string;
}): JSX.Element {
  const inUse = useId();
  const view = useCurrentView();
  const chosen = value;
  const shown = chosen ?? (order === "distance" ? "distance" : AUTO);
  const bestMatch = chosen === undefined && order === "relevance";
  return (
    <div className="flex flex-col gap-2">
      <Chips<Sort | typeof AUTO>
        labelledBy={labelledBy}
        describedBy={bestMatch ? inUse : undefined}
        options={[
          { id: "score", label: view === "circle" ? copy.filters.sort.circleScore : copy.filters.sort.score },
          { id: "distance", label: copy.filters.sort.distance },
          { id: "name", label: copy.filters.sort.name },
        ]}
        value={shown}
        resting={AUTO}
        onChange={(pressed) => {
          // A chip pressed again comes back as AUTO. One the person chose goes back to no sort; one that
          // only showed the order in use is chosen now.
          if (pressed !== AUTO) onChange(pressed);
          else onChange(chosen === undefined && shown !== AUTO ? shown : undefined);
        }}
      />
      {bestMatch && (
        <p id={inUse} className="m-0 text-caption text-muted">
          {copy.search.sortedBy.relevance}
        </p>
      )}
    </div>
  );
}

/** The switch for Open now, with the line that says what it does with places that have no hours. */
export function OpenNowSwitch({ checked, onChange }: { checked: boolean; onChange(checked: boolean): void }): JSX.Element {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 border-t-token border-b-token border-line py-1">
      <div className="flex flex-col gap-0.5 py-2.5">
        <div id={`${id}-label`} className="text-body font-bold">
          {copy.filters.openNow}
        </div>
        <div id={`${id}-note`} className="text-caption text-muted">
          {copy.filters.openNowNote}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={`${id}-label`} describedBy={`${id}-note`} />
    </div>
  );
}

const OPTION_ON = "border-0 bg-emphasis text-on-emphasis";
const OPTION_OFF = "border-token border-line-strong bg-ground text-ink";

/**
 * How far to look: five distances in a row, in the unit the person reads: half a mile to 15 miles,
 * or 1 to 25 kilometres. `value` and what is chosen are kilometres. Pressing the one that is on
 * goes back to the widest, which is no limit short of the city.
 */
export function WithinOptions({
  value,
  onChange,
  locale,
  labelledBy,
}: {
  value: number;
  onChange(km: number): void;
  locale: string;
  labelledBy: string;
}): JSX.Element {
  const widest = widestKm(locale);
  return (
    <div role="group" aria-labelledby={labelledBy} className="grid grid-cols-5 gap-2">
      {withinChoices(locale).map(({ km, label }) => {
        const chosen = km === value;
        return (
          <button
            key={km}
            type="button"
            aria-pressed={chosen}
            onClick={() => {
              if (chosen && km === widest) return;
              onChange(chosen ? widest : km);
            }}
            className={`h-11 cursor-pointer rounded-tile font-text text-secondary font-semibold ${chosen ? OPTION_ON : OPTION_OFF}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** The ten families of places, two to a row, each with its icon. Any number can be on; none is every kind. */
export function KindOptions({
  value,
  onChange,
  labelledBy,
}: {
  value: FamilyId[];
  onChange(families: FamilyId[]): void;
  labelledBy: string;
}): JSX.Element {
  return (
    <div role="group" aria-labelledby={labelledBy} className="grid grid-cols-2 gap-2">
      {FAMILIES.map(({ id, label }) => {
        const chosen = value.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={chosen}
            onClick={() => {
              const next = new Set(value);
              if (chosen) next.delete(id);
              else next.add(id);
              // Always in the order of the ten, whatever order they were chosen in.
              onChange(FAMILIES.map((family) => family.id).filter((each) => next.has(each)));
            }}
            className={`flex h-14 cursor-pointer items-center gap-2.5 rounded-button border-token px-3 text-left font-text text-secondary font-semibold ${
              chosen ? "border-emphasis bg-emphasis text-on-emphasis" : "border-line-strong bg-ground text-ink"
            }`}
          >
            <FamilyIcon family={id} className="size-6" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
