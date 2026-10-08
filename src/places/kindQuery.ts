import { foldText } from "./fold.ts";
import type { Place } from "./place.ts";
import { cuisineLabel, FAMILIES, type FamilyId, KIND_SYNONYMS, KINDS, kindOf } from "./kinds.ts";

/**
 * A kind query is one whose every word names a family of places, a kind, a word that means a
 * family (`KIND_SYNONYMS`) or a cuisine that a place has: "cafe", "coffee", "pizza", "fast
 * food", "italian restaurant". People who search that way mean the ones near them, so the search
 * lists them by distance. This is the vocabulary of such queries, and what a place answers to.
 */

/** Text as a term of a kind query: folded, with its words, and only its words, a space apart. */
export function termOf(text: string): string {
  return foldText(text)
    .split(/[\s\p{P}]+/u)
    .filter((word) => word !== "")
    .join(" ");
}

/** What a family is called: its label, and each side of a label that joins two with "and". */
function familyNames(label: string): string[] {
  const whole = termOf(label);
  return [whole, ...whole.split(" and ")];
}

/** The terms a place of a family answers to: its names, and the words that mean the family. */
const FAMILY_TERMS: ReadonlyMap<FamilyId, readonly string[]> = new Map(
  FAMILIES.map((family) => {
    const synonyms = Object.entries(KIND_SYNONYMS).flatMap(([word, of]) => (of === family.id ? [termOf(word)] : []));
    return [family.id, [...new Set([...familyNames(family.label), ...synonyms])].filter((term) => term !== "")];
  }),
);

const termsByCategory = new Map<string, readonly string[]>();

/** The terms a place of that category answers to: its family's, and its kind's label. */
export function termsOfCategory(category: string): readonly string[] {
  let terms = termsByCategory.get(category);
  if (terms === undefined) {
    const kind = kindOf(category);
    terms = [...new Set([...(FAMILY_TERMS.get(kind.family) ?? []), termOf(kind.label)])].filter((term) => term !== "");
    termsByCategory.set(category, terms);
  }
  return terms;
}

const termsByCuisine = new Map<string, string>();

/** The term for a cuisine: its label, so "coffee_shop" is "coffee shop". Empty when there is none. */
function termOfCuisine(cuisine: string): string {
  let term = termsByCuisine.get(cuisine);
  if (term === undefined) {
    term = termOf(cuisineLabel(cuisine));
    termsByCuisine.set(cuisine, term);
  }
  return term;
}

/**
 * The cuisines of a place, as terms: its keywords (the tags of the data, which hold every cuisine
 * as well as its kind and its town), less the kind and the town, and its first cuisine. A tag
 * that lists several cuisines with commas ("döner, pizza") gives each. A word of the town is
 * never a cuisine, and neither is the place's own kind.
 */
export function cuisinesOf(place: Pick<Place, "category" | "cuisine" | "locality" | "keywords">): string[] {
  const own = new Set([termOfCuisine(place.category), place.locality === undefined ? "" : termOf(place.locality)]);
  const cuisines = new Set<string>();
  for (const value of place.cuisine === undefined ? place.keywords : [place.cuisine, ...place.keywords]) {
    for (const part of value.split(",")) {
      const term = termOfCuisine(part.trim());
      if (term !== "" && !own.has(term)) cuisines.add(term);
    }
  }
  return [...cuisines];
}

/** Every term that is a kind of place or a family, before any cuisine of the data is added. */
export const KIND_VOCABULARY: ReadonlySet<string> = new Set([
  ...[...FAMILY_TERMS.values()].flat(),
  ...KINDS.map((kind) => termOf(kind.label)),
]);

/**
 * A reader of queries for a vocabulary: the terms of a query whose every word is in it, or
 * undefined if one is not. The longest label that fits comes first, so "ice cream" is one
 * term and not two words, and "coffee shop" is the cuisine and not "coffee" and "shop".
 */
export function kindQueryReader(vocabulary: ReadonlySet<string>): (q: string) => string[] | undefined {
  const longest = Math.max(1, ...[...vocabulary].map((term) => term.split(" ").length));
  return (q) => {
    const words = termOf(q).split(" ").filter((word) => word !== "");
    if (words.length === 0) return undefined;
    const terms: string[] = [];
    let at = 0;
    while (at < words.length) {
      let size = Math.min(longest, words.length - at);
      while (size > 0 && !vocabulary.has(words.slice(at, at + size).join(" "))) size -= 1;
      if (size === 0) return undefined;
      terms.push(words.slice(at, at + size).join(" "));
      at += size;
    }
    return terms;
  };
}
