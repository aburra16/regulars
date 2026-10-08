import type { JSX, ReactNode } from "react";

import { copy } from "../copy/en.ts";

/** Each source's terms, which its name in the line links to. */
const TERMS = {
  mapTiler: "https://www.maptiler.com/copyright/",
  openStreetMap: "https://www.openstreetmap.org/copyright",
} as const;

type Link = readonly [label: string, href: string];

const LINKS: Record<"map" | "details", readonly Link[]> = {
  map: [
    [copy.attribution.mapTiler, TERMS.mapTiler],
    [copy.attribution.openStreetMap, TERMS.openStreetMap],
  ],
  details: [[copy.attribution.openStreetMap, TERMS.openStreetMap]],
};

/** The line, with each link's words made a link that opens in a new tab. The links are found in order. */
function withLinks(text: string, links: readonly Link[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = text;
  for (const [label, href] of links) {
    const at = rest.indexOf(label);
    if (at === -1) continue;
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push(
      <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="text-ink underline hover:text-accent">
        {label}
      </a>,
    );
    rest = rest.slice(at + label.length);
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/**
 * Where the map or the place details come from, as the licences ask. `map` is the small label on
 * every map ("© MapTiler © OpenStreetMap contributors"); the map places it. `details` is the line
 * on the place, search and chain pages ("Place details © OpenStreetMap contributors, via BTC Map").
 */
export function Attribution({ kind }: { kind: "map" | "details" }): JSX.Element {
  const line = withLinks(copy.attribution[kind], LINKS[kind]);
  return kind === "map" ? (
    <p className="m-0 inline-block rounded-[8px] bg-ground px-2 py-[3px] text-[11px] font-semibold text-muted">{line}</p>
  ) : (
    <p className="m-0 text-caption text-muted">{line}</p>
  );
}
