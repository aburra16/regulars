import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";

import { FilterIcon } from "./icons.tsx";

/**
 * A chip is 44 px tall with a 1.5 px edge (Main.dc.html). The chosen one is filled and has no edge,
 * as in the design; it takes the edge's width as padding, so the row does not move when a chip is
 * chosen or let go.
 */
const CHIP = "inline-flex h-11 items-center rounded-chip font-text text-[15px] font-semibold";
const CHIP_ON = "border-0 bg-ink px-[calc(1rem+var(--border))] text-ground";
const CHIP_OFF = "border-token border-line-strong bg-ground px-4 text-ink";
/** A chip that cannot be chosen: the lighter edge and the muted words. */
const CHIP_DISABLED = "cursor-not-allowed border-token border-line bg-ground px-4 text-muted";

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** A chip that cannot be chosen (yet): drawn plainly, not pressable. `describedBy` is the id of the line that says why. */
  disabled?: boolean;
  describedBy?: string;
}

/**
 * A row of chips, one chosen at a time, as pressed buttons. A chip that is pressed again goes
 * back to `resting`, the chip that stands for no filter; pressing that one changes nothing.
 * `children` come after the chips (the More link).
 */
export function Chips<T extends string>({
  label,
  options,
  value,
  resting,
  onChange,
  children,
}: {
  /** The row's name, for a screen reader. */
  label: string;
  options: readonly ChipOption<T>[];
  value: T;
  resting: T;
  onChange(chip: T): void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={chosen}
            disabled={option.disabled}
            aria-describedby={option.describedBy}
            onClick={() => {
              if (chosen && option.id === resting) return;
              onChange(chosen ? resting : option.id);
            }}
            className={`${CHIP} ${chosen ? `cursor-pointer ${CHIP_ON}` : option.disabled ? CHIP_DISABLED : `cursor-pointer ${CHIP_OFF}`}`}
          >
            {option.label}
          </button>
        );
      })}
      {children}
    </div>
  );
}

/** A chip that goes to another page and has an icon in front: "More", which opens the filters. */
export function ChipLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link to={to} className={`gap-1.5 no-underline ${CHIP} ${CHIP_OFF}`}>
      <FilterIcon size={16} />
      {children}
    </Link>
  );
}
