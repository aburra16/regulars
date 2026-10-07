import { foldText } from "./fold.ts";
import { cuisineLabel, FAMILIES, FAMILY_SEARCH_TERMS, type FamilyId, KINDS, kindOf } from "./kinds.ts";

/**
 * A kind query is one whose every word names a kind of place, a family of them or a cuisine: "cafe",
 * "coffee", "pizza", "fast food", "italian restaurant". People who search that way mean the ones
 * near them, so the search lists them by distance. This is the vocabulary of such queries, and
 * what a place answers to.
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

/** The terms a place of a family answers to: its names, and the words people use for it. */
const FAMILY_TERMS: ReadonlyMap<FamilyId, readonly string[]> = new Map(
  FAMILIES.map((family) => {
    const words = (FAMILY_SEARCH_TERMS[family.id] ?? "").split(/\s+/).map(termOf);
    return [family.id, [...new Set([...familyNames(family.label), ...words])].filter((term) => term !== "")];
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

/** The term for a cuisine: its label. Empty when there is none. */
export function termOfCuisine(cuisine: string): string {
  return termOf(cuisineLabel(cuisine));
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
