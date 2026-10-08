import { type FocusEvent, type JSX, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { copy } from "../copy/en.ts";
import { familyLabel } from "../places/kinds.ts";
import { KindOptions, SortOptions, WithinOptions } from "../search/FilterControls.tsx";
import { type Filters, sortInUse, widestKm, withinLabel } from "../search/filters.ts";
import type { Order } from "../search/useResults.ts";
import { ChevronDownIcon } from "../ui/icons.tsx";

/**
 * A chip of the menu row (DeskExplore.dc.html): drawn 40 px tall, with an invisible 2 px above and
 * below that makes it a 44 px target. The pressed one is filled and has no edge; it takes the
 * edge's width as padding, so the row does not move.
 */
const CHIP =
  "relative inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-[20px] font-text text-secondary font-semibold after:absolute after:inset-x-0 after:-inset-y-0.5";
const CHIP_ON = "border-0 bg-emphasis px-[calc(0.875rem+var(--border))] text-on-emphasis";
const CHIP_OFF = "border-token border-line-strong bg-ground px-3.5 text-ink";

/**
 * A chip that opens a panel of controls under it. The panel has its heading, which names the
 * controls in it. It closes on Escape (the focus goes back to the chip), on a click outside it, when
 * the focus leaves it, and when `children` call `close` (a choice of one that is made).
 */
function Menu({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children(headingId: string, close: () => void): ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus that goes somewhere outside the menu (Tab past its last control) closes it.
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
  };

  return (
    <div ref={root} className="relative" onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
        className={`${CHIP} ${CHIP_OFF}`}
      >
        {label}
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute top-full left-0 z-20 mt-2 flex w-[360px] flex-col gap-2.5 rounded-panel border-token border-line bg-ground p-4 shadow-float"
        >
          <h2 id={headingId} className="m-0 text-body font-bold">
            {title}
          </h2>
          {children(headingId, () => {
            setOpen(false);
            button.current?.focus();
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The desktop's filters, in a row above Explore's list (DeskExplore.dc.html): Open now, which is a
 * chip of its own, and the kinds, the distance and the sort, each a menu of the same controls the
 * phone's filters page has. Each menu is named for what it is set to ("Within 2 mi"), the sort for the
 * order the list is in ("Sort: name", "Sort: best match").
 * A choice is made at once; the page keeps the filters in the address, as the search does.
 */
export function FilterMenus({
  filters,
  order,
  onChange,
  locale,
}: {
  filters: Filters;
  /** The order the list is in, which the sort menu is named for and shows when no sort is chosen. */
  order: Order;
  onChange(next: Filters): void;
  locale: string;
}): JSX.Element {
  const sort = sortInUse(filters);
  const [firstKind] = filters.families;
  const within =
    filters.withinKm === widestKm(locale) ? copy.filters.distance : copy.search.within(withinLabel(filters.withinKm, locale));
  return (
    <div role="group" aria-label={copy.explore.filtersLabel} className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={filters.open}
        onClick={() => onChange({ ...filters, open: !filters.open })}
        className={`${CHIP} ${filters.open ? CHIP_ON : CHIP_OFF}`}
      >
        {copy.filters.openNow}
      </button>
      <Menu
        label={copy.deskExplore.kinds(filters.families.length, firstKind === undefined ? "" : familyLabel(firstKind))}
        title={copy.filters.kinds}
      >
        {(headingId) => (
          <KindOptions
            value={filters.families}
            onChange={(families) => onChange({ ...filters, families })}
            labelledBy={headingId}
          />
        )}
      </Menu>
      <Menu label={within} title={copy.filters.distance}>
        {(headingId, close) => (
          <WithinOptions
            value={filters.withinKm}
            onChange={(withinKm) => {
              onChange({ ...filters, withinKm });
              close();
            }}
            locale={locale}
            labelledBy={headingId}
          />
        )}
      </Menu>
      <Menu label={copy.deskExplore.sort[order]} title={copy.filters.sortBy}>
        {(headingId, close) => (
          <SortOptions
            value={sort}
            order={order}
            onChange={(next) => {
              onChange({ ...filters, sort: next });
              close();
            }}
            labelledBy={headingId}
          />
        )}
      </Menu>
    </div>
  );
}
