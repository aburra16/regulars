import { type JSX, type MouseEvent, type PointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { copy } from "../copy/en.ts";
import { foldText } from "../places/fold.ts";
import { type City, cityLabeller } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { lockPage } from "../ui/lockPage.ts";
import { useHere } from "./useLocation.ts";

/** How many cities the list shows. A person who wants another types a few letters of it. */
const MAX_ROWS = 50;

/** What the Tab key can reach inside the dialog. */
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

const icon = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function PinIcon({ size = 18, strokeWidth = 2.2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg {...icon} width={size} height={size} strokeWidth={strokeWidth} className="shrink-0 text-accent">
      <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...icon} width="16" height="16" className="shrink-0">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...icon} width="22" height="22" strokeWidth={2.4}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg {...icon} width="20" height="20" className="shrink-0 text-you-are-here">
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5" />
    </svg>
  );
}

interface Row {
  city: City;
  label: string;
  /** The label as the filter reads it: lower case, without accents. */
  folded: string;
}

/**
 * Where to look for places: a full-screen sheet on a phone and a dialog on a desktop. It lists
 * the towns of the places that loaded, the biggest first, and a field filters them. "Use my
 * location" is above them. It calls back and leaves the choice, and closing, to its parent.
 */
export function CityPicker({
  onPick,
  onUseDevice,
  onClose,
}: {
  onPick(c: City): void;
  onUseDevice(): void;
  onClose(): void;
}): JSX.Element {
  const titleId = useId();
  const filterId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  const cities = useIndexes()?.cities;
  const rows = useMemo<Row[]>(() => {
    const all = cities ?? [];
    const label = cityLabeller(all);
    // The sort is stable: towns with as many places keep the order they came in.
    return [...all]
      .sort((a, b) => b.count - a.count)
      .map((city) => {
        const name = label(city);
        return { city, label: name, folded: foldText(name) };
      });
  }, [cities]);
  const shown = useMemo(() => {
    const wanted = foldText(query.trim());
    return (wanted === "" ? rows : rows.filter((row) => row.folded.includes(wanted))).slice(0, MAX_ROWS);
  }, [rows, query]);

  // The page behind can be neither scrolled nor reached while this is open. This effect comes
  // before the focus one: a closing dialog runs its cleanups in this order, so the page is
  // reachable again by the time the focus goes back to it.
  useEffect(() => lockPage(), []);

  // The focus goes to the filter when it opens, and back to what had it when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    filterRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Escape closes. The Tab key stays inside, because the page behind is out of reach.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || dialog === null) return;
      const reachable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = reachable[0];
      const last = reachable.at(-1);
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A tap on the screen beside the dialog, on a desktop, closes it. Only a press that began
  // there: dragging to select the filter's text past the dialog's edge ends with a click on the
  // screen beside it, and that is not a tap.
  const pressedBeside = useRef(false);
  const notePress = (event: PointerEvent<HTMLDivElement>) => {
    pressedBeside.current = event.target === event.currentTarget;
  };
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (pressedBeside.current && event.target === event.currentTarget) onClose();
    pressedBeside.current = false;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex bg-ground wide:items-center wide:justify-center wide:bg-shade/60 wide:p-4"
      onPointerDown={notePress}
      onClick={closeOnBackdrop}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex min-h-0 w-full flex-col bg-ground font-text text-ink wide:h-[80vh] wide:max-h-full wide:max-w-[580px] wide:rounded-dialog wide:shadow-dialog"
      >
        {/* The title starts at the gutter; the close button's 44 px target reaches into it, toward the edge. */}
        <div className="flex items-center justify-between px-gutter-phone pt-3.5 wide:px-7 wide:pt-2.5">
          <h2 id={titleId} className="m-0 font-display text-h2 font-extrabold tracking-display wide:text-[26px]">
            {copy.location.pickTitle}
          </h2>
          <button
            type="button"
            aria-label={copy.location.close}
            onClick={onClose}
            className="-mr-2 flex min-h-touch min-w-touch cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-ink wide:-mr-3.5"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-gutter-phone pt-2 wide:px-7">
          <button
            type="button"
            onClick={onUseDevice}
            className="flex min-h-touch w-full cursor-pointer items-center gap-3 rounded-button border-token border-line-strong bg-ground px-4 py-3 text-left text-body font-semibold text-ink hover:bg-surface"
          >
            <LocateIcon />
            {copy.location.useMine}
          </button>
          <div>
            <label htmlFor={filterId} className="sr-only">
              {copy.location.filterPlaceholder}
            </label>
            <input
              ref={filterRef}
              id={filterId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.location.filterPlaceholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              className="box-border h-13 w-full rounded-button border-token border-field-border bg-ground px-4 text-body text-ink placeholder:text-muted"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-gutter-phone pt-3 pb-5 wide:px-7">
          {shown.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {shown.map(({ city, label }) => (
                <li key={`${city.name}|${city.region ?? ""}|${city.country}`}>
                  <button
                    type="button"
                    onClick={() => onPick(city)}
                    className="flex min-h-touch w-full cursor-pointer items-center justify-between gap-3 rounded-button border-0 bg-transparent px-4 py-2 text-left text-body font-semibold text-ink hover:bg-surface"
                  >
                    <span>{label}</span>{" "}
                    <span className="shrink-0 text-secondary font-normal text-muted">
                      {copy.location.count(city.count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            query.trim() !== "" && (
              <p role="status" className="m-0 px-4 py-3 text-secondary text-muted">
                {copy.location.noMatch}
              </p>
            )
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The picker, wired to `useHere`: a pick moves every screen to that city, "Use my location" asks
 * the browser, and either one closes it. Open it wherever a person is offered another town.
 */
export function HereCityPicker({ onClose }: { onClose(): void }): JSX.Element {
  const here = useHere();
  return (
    <CityPicker
      onPick={(city) => {
        here.pickCity(city);
        onClose();
      }}
      onUseDevice={() => {
        here.useDevice();
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/**
 * "Near Funchal ˅": where the places are near, as a button that opens the picker. The pick
 * moves every screen below the `HereProvider`. "Use my location" asks the browser, and while it
 * has not answered the button reads "Finding your location…"; if it says no or cannot,
 * `LocationNotice` says why. `plain` is the control at the top of the phone's Explore; `pill`
 * sits at the end of the desktop search field, with the pin and no chevron.
 */
export function NearButton({ variant = "plain" }: { variant?: "plain" | "pill" }): JSX.Element {
  const here = useHere();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The focus comes back here whenever the picker closes, whichever way. The picker gives it back
  // to what had it, but Safari does not focus a button that is clicked, so that may be nothing.
  // This runs after the picker has gone and unlocked the page.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  const text = here.pending ? copy.location.finding : copy.explore.near(here.label);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={
          variant === "pill"
            ? "inline-flex min-h-touch shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-secondary font-semibold text-ink"
            : "inline-flex min-h-touch cursor-pointer items-center gap-1.5 self-start border-0 bg-transparent p-0 text-body font-semibold text-ink"
        }
      >
        {variant === "pill" ? (
          // Drawn 36 px tall inside the 48 px field, as the design has it; the button around it is 44 px to tap.
          <span className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-ground px-3">
            <PinIcon size={15} strokeWidth={2.4} />
            {/* A long name is cut short here, so the search field keeps its shape; the picker shows it whole. */}
            <span className="max-w-48 truncate">{text}</span>
          </span>
        ) : (
          <>
            <PinIcon />
            {text}
            <ChevronIcon />
          </>
        )}
      </button>
      {open && <HereCityPicker onClose={() => setOpen(false)} />}
    </>
  );
}
