import type { JSX } from "react";

import "./built-on-brainstorm.js";

/**
 * Brainstorm's shared line, `<built-on-brainstorm>` (./built-on-brainstorm.js, copied as Brainstorm
 * gives it). It draws the mark, the words and the link in a shadow root of its own, and takes its look
 * from Brainstorm's site, which the page's policy lets in as a stylesheet (tools/csp.ts). The app gives
 * it its size and its colours, through the properties the line reads.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "built-on-brainstorm": HTMLAttributes<HTMLElement>;
    }
  }
}

/**
 * The line's colours, by the ground it is on: the page's (the caption colour the credits have, and
 * the ink when it is pointed at or focused); or the sign-in page's dark ground, which keeps the light
 * theme's colours (that page's caption colour, and its white). The focus ring is the colour the line
 * turns to.
 */
export const TONES = {
  page: "[--built-on-color:var(--muted)] [--built-on-hover-color:var(--ink)]",
  night: "[--built-on-color:var(--line-dashed)] [--built-on-hover-color:var(--ground)]",
} as const;

/**
 * "Built on Brainstorm", the quiet line at the foot of every page: Brainstorm's
 * mark, then the words, the whole of it one link to Brainstorm's own site, which opens in a new tab
 * and is told nothing of where the person came from. A caption, with the room a tap needs; underlined
 * only when it is pointed at or focused. It sends nothing but the request for its look.
 * The shell draws it for the pages that scroll (src/shell/Shell.tsx), and the desktop's list beside
 * the map in its own footer (src/explore/DeskLayout.tsx).
 */
export function BuiltOnBrainstorm({ tone = "page", className = "" }: { tone?: keyof typeof TONES; className?: string }): JSX.Element {
  return <built-on-brainstorm className={`text-caption ${TONES[tone]} ${className}`.trim()} />;
}
