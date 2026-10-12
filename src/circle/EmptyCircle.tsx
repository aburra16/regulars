import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useCircleEmptiness } from "../score/useScore.ts";
import { useCurrentView } from "../view/ViewProvider.tsx";
import { useCircle } from "./CircleProvider.tsx";

/** The line that says nobody in the circle has rated places yet: or only the person, when they have (ruling R8). */
export const emptyCircleLine = (youRated: boolean): string => (youRated ? copy.explore.circleOnlyYou : copy.explore.circleEmpty);

/**
 * Says plainly, while My circle is the view, that nobody in the person's circle has rated the places
 * seen this session yet (or only they have), and that House picks still has scores for them (a circle
 * of one: the brief's § 6, rulings R7 and R8). It goes where the toggle is, which keeps House picks one
 * tap away; nothing here switches the view for them. Where Personalize sits too (`withPersonalize`),
 * an unconfirmed circle's line is said there, with the way to work it out again, and not here
 * (ruling R10). A polite status, always there, so a screen reader hears the line when it comes with
 * the toggle; empty otherwise. `className` places it, and styles its line (`*:`).
 */
export function EmptyCircle({ className, withPersonalize = false }: { className?: string; withPersonalize?: boolean }): JSX.Element {
  const { empty, youRated } = useCircleEmptiness();
  const view = useCurrentView();
  const { state } = useCircle();
  const shown = view === "circle" && empty && !(withPersonalize && state === "unconfirmed");
  return (
    <div role="status" className={className}>
      {shown && <p className="m-0 text-secondary leading-[1.4] font-semibold text-trust">{emptyCircleLine(youRated)}</p>}
    </div>
  );
}
