import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useEmptyCircle } from "../score/useScore.ts";

/**
 * Says plainly, while My circle is the view, that nobody in the person's circle has rated the places
 * they have seen yet, and that House picks still has scores for them (a circle of one: the brief's
 * § 6, ruling R7). It goes where the toggle is, which keeps House picks one tap away; nothing here
 * switches the view for them. A polite status, always there, so a screen reader hears the line when
 * it comes with the toggle; empty otherwise. `className` places it, and styles its line (`*:`).
 */
export function EmptyCircle({ className }: { className?: string }): JSX.Element {
  const empty = useEmptyCircle();
  return (
    <div role="status" className={className}>
      {empty && <p className="m-0 text-secondary leading-[1.4] font-semibold text-trust">{copy.explore.circleEmpty}</p>}
    </div>
  );
}
