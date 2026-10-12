import type { JSX } from "react";

import house64 from "../assets/house/house-64.png";
import house96 from "../assets/house/house-96.png";
import { copy } from "../copy/en.ts";

/**
 * The badge's two sizes, each drawn from a file three to four times as large, so it stays sharp on a
 * phone's screen (tools/house-icons.sh makes them):
 * - `line`: 20 px, in 14 px text (Explore's house line);
 * - `body`: 24 px, in 16 px text (About).
 * Each is as tall as its line of text, or a hair taller: its negative margins keep the line as tall
 * as the lines around it. Set on the bottom of the text, it sits centred on the letters.
 */
const BADGES = {
  line: { src: house64, px: 20, className: "size-5 -my-0.5 mr-1" },
  body: { src: house96, px: 24, className: "size-6 -my-1 mr-1.5" },
} as const;

/**
 * The house's logo, round, before its name. It is decoration, since the name follows it, so a screen
 * reader skips it. Shown anywhere without the name, it would need `copy.house.name` as its words.
 */
function HouseBadge({ size }: { size: keyof typeof BADGES }): JSX.Element {
  const { src, px, className } = BADGES[size];
  return (
    <img src={src} alt="" width={px} height={px} className={`inline-block rounded-full align-text-bottom ${className}`} />
  );
}

/**
 * `text` with the house's badge in front of the house's name, the two kept together on one line. A
 * text that does not name the house is drawn as it is.
 */
export function HouseName({ text, size }: { text: string; size: keyof typeof BADGES }): JSX.Element {
  const name = copy.house.name;
  const at = text.indexOf(name);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="whitespace-nowrap">
        <HouseBadge size={size} />
        {name}
      </span>
      {text.slice(at + name.length)}
    </>
  );
}
