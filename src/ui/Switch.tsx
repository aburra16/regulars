import type { JSX } from "react";

/**
 * A switch, as the design draws Open now's (Filters): a track 56 by 32 with a knob of 24, 4 in from
 * its edge; off, the track is grey; on, it is the emphasis fill and the knob is at its end. 44 px tall
 * to tap. It is named by the words beside it, and can be described by a line under them.
 */
export function Switch({
  id,
  checked,
  onChange,
  labelledBy,
  describedBy,
}: {
  /** Its id, for a <label> around its row that turns it too. */
  id?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  /** The id of the words that name it. */
  labelledBy: string;
  /** The id of a line that says more, if there is one. */
  describedBy?: string;
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className="h-11 w-14 shrink-0 cursor-pointer border-0 bg-transparent px-0 py-1.5"
    >
      <span aria-hidden="true" className={`relative block h-8 w-14 rounded-full ${checked ? "bg-emphasis" : "bg-field-border"}`}>
        <span className={`absolute top-1 size-6 rounded-full bg-ground ${checked ? "right-1" : "left-1"}`} />
      </span>
    </button>
  );
}
