import type { JSX } from "react";

import starSvg from "../assets/icons/star.svg?raw";
import { copy } from "../copy/en.ts";

const STARS = [0, 1, 2, 3, 4] as const;

/** How big each star is: 16 px in a line of a review, 20 px beside a place's big score in its panel (Place.dc.html). */
const SIZE = { line: "size-4", panel: "size-5" } as const;

/** One star from the icon file, drawn in the text colour. */
function Star({ size }: { size: keyof typeof SIZE }) {
  return (
    <span
      className={`block ${SIZE[size]} [&>svg]:size-full`}
      // Safe: the text is our own icon file, bundled at build time, never data from outside.
      dangerouslySetInnerHTML={{ __html: starSvg }}
    />
  );
}

/**
 * Five stars for a score from 0 to 5, to the nearest half star: filled in the accent colour and empty
 * in the strong line colour; or, dimmed for a folded review (`tone="muted"`), filled in the muted
 * colour and empty in the line colour, which keeps the two apart in both themes. 16 px each, or 20
 * (`size="panel"`). A screen reader hears the score itself: "4.5 out of 5".
 */
export function Stars({
  value,
  size = "line",
  tone = "accent",
}: {
  value: number;
  size?: keyof typeof SIZE;
  tone?: "accent" | "muted";
}): JSX.Element {
  const score = Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 0;
  const halves = Math.round(score * 2);
  const filled = tone === "accent" ? "text-accent" : "text-muted";
  const empty = tone === "accent" ? "text-line-strong" : "text-line";
  return (
    <span role="img" aria-label={copy.score.starsLabel(score)} className="inline-flex shrink-0 gap-px">
      {STARS.map((i) => {
        const fill = halves >= 2 * i + 2 ? "full" : halves === 2 * i + 1 ? "half" : "empty";
        return (
          <span key={i} data-fill={fill} className={`relative ${SIZE[size]} shrink-0 ${empty}`}>
            <Star size={size} />
            {fill !== "empty" && (
              <span className={`absolute inset-y-0 left-0 overflow-hidden ${filled} ${fill === "half" ? "w-1/2" : "w-full"}`}>
                <Star size={size} />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
