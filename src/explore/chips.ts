import { copy } from "../copy/en.ts";
import { openState } from "../places/hours.ts";
import { FAMILIES, type FamilyId, kindOf } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";

/** The filter chips on Explore, in order. `all` is the one that is on when none is chosen. */
export const EXPLORE_CHIPS = ["all", "open", "restaurants", "cafes"] as const;
export type ExploreChip = (typeof EXPLORE_CHIPS)[number];

/** The chip a kind-of-place chip stands for. */
const FAMILY_OF: Partial<Record<ExploreChip, FamilyId>> = { restaurants: "restaurants", cafes: "cafes" };

function familyLabel(id: FamilyId): string {
  return FAMILIES.find((family) => family.id === id)?.label ?? id;
}

/** What each chip says: the kind chips take the name the kind families already have. */
export const CHIP_LABELS: Record<ExploreChip, string> = {
  all: copy.explore.chips.all,
  open: copy.explore.chips.open,
  restaurants: familyLabel("restaurants"),
  cafes: familyLabel("cafes"),
};

/** Where the chip is kept in the address: `?chip=open`. */
export const CHIP_PARAM = "chip";

/** The chip an address names. Anything else, or none, is All. */
export function chipFromParam(value: string | null): ExploreChip {
  return EXPLORE_CHIPS.find((chip) => chip === value) ?? "all";
}

/** Whether a place stays in the list under a chip. `now` matters only to Open now. */
export function chipKeeps(chip: ExploreChip, place: Place, now: Date): boolean {
  if (chip === "all") return true;
  if (chip === "open") return openState(place, now).kind === "open";
  return kindOf(place.category).family === FAMILY_OF[chip];
}
