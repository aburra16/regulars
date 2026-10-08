import type { JSX } from "react";

import starSvg from "../assets/icons/star.svg?raw";
import { copy } from "../copy/en.ts";

const STARS = [0, 1, 2, 3, 4] as const;

/** One star from the icon file, 16 px, drawn in the text colour. */
function Star() {
  return (
    <span
      className="block size-4 [&>svg]:size-full"
      // Safe: the text is our own icon file, bundled at build time, never data from outside.
      dangerouslySetInnerHTML={{ __html: starSvg }}
    />
  );
}

/**
 * Five 16 px stars for a score from 0 to 5, to the nearest half star: filled in the accent colour,
 * empty in the strong line colour. A screen reader hears the score itself: "4.5 out of 5".
 */
export function Stars({ value }: { value: number }): JSX.Element {
  const score = Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 0;
  const halves = Math.round(score * 2);
  return (
    <span role="img" aria-label={copy.score.starsLabel(score)} className="inline-flex shrink-0 gap-px">
      {STARS.map((i) => {
        const fill = halves >= 2 * i + 2 ? "full" : halves === 2 * i + 1 ? "half" : "empty";
        return (
          <span key={i} data-fill={fill} className="relative size-4 shrink-0 text-line-strong">
            <Star />
            {fill !== "empty" && (
              <span className={`absolute inset-y-0 left-0 overflow-hidden text-accent ${fill === "half" ? "w-1/2" : "w-full"}`}>
                <Star />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
