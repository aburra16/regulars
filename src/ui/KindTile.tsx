import type { JSX } from "react";

import kinds from "../data/kinds.json";
import { type FamilyId, FAMILIES, kindOf } from "../places/kinds.ts";

/**
 * Each family's icon as svg text, so it can sit in the page and take the tile's text colour
 * through `currentColor`. An `<img>` of the same file cannot be tinted.
 */
const svgText = import.meta.glob<string>("../assets/icons/*.svg", { eager: true, query: "?raw", import: "default" });

const ICONS = new Map<FamilyId, string>(
  FAMILIES.map(({ id }) => {
    const file = kinds.families.find((family) => family.id === id)?.icon;
    const svg = file === undefined ? undefined : svgText[`../assets/icons/${file}`];
    if (svg === undefined) throw new Error(`No icon in src/assets/icons for the ${id} family`);
    return [id, svg];
  }),
);

/** The tile and icon sizes of each place the tile is drawn: the card (Main), the row (Search), the place page's header (Place, DeskPlace). */
const SIZE = {
  card: { tile: "size-13 rounded-tile", icon: "size-[26px]" },
  row: { tile: "size-11 rounded-[12px]", icon: "size-[22px]" },
  page: { tile: "size-14 rounded-[16px] wide:size-16 wide:rounded-[18px]", icon: "size-7 wide:size-8" },
} as const;

/** The tile's colour: grey on a white card, white on a tinted card, and dark on a chain row. */
const TONE = {
  surface: "bg-surface text-ink",
  ground: "bg-ground text-ink",
  ink: "bg-ink text-ground",
} as const;

/** The icon of a place's kind, on a rounded tile. It is decoration: the kind is always in words beside it. */
export function KindTile({
  category,
  size,
  tone = "surface",
}: {
  category: string;
  size: "card" | "row" | "page";
  tone?: keyof typeof TONE;
}): JSX.Element {
  const svg = ICONS.get(kindOf(category).family);
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center ${SIZE[size].tile} ${TONE[tone]}`}>
      <span
        className={`block ${SIZE[size].icon} [&>svg]:size-full`}
        // Safe: the text is one of our own icon files, bundled at build time, never data from outside.
        dangerouslySetInnerHTML={{ __html: svg ?? "" }}
      />
    </span>
  );
}
