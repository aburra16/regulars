import type { City } from "./indexes.ts";
import { foldName } from "./towns.ts";

/*
 * Finding a town by what a person types: in the town picker (CityPicker), and among the search's
 * results (the Towns above the places). Both read a town's name, the label the list shows it by
 * ("Lexington, KY"), and its other names (`City.aliases`: its ASCII name, and the localities its
 * places give it, "Praha" for Prague), all folded, so case and accents do not count.
 */

/** The words of folded text: its runs of letters and digits. */
const wordsOf = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");

/**
 * Whether the picker lists a town for what is typed (`typed`, folded as `foldName` folds it): the
 * text is anywhere in the label it shows (`label`, folded the same way), or in one of the town's other
 * names. Typing nothing lists every town.
 */
export function pickerMatches(city: City, label: string, typed: string): boolean {
  if (typed === "") return true;
  return label.includes(typed) || (city.aliases ?? []).some((alias) => alias.includes(typed));
}

/**
 * How well one name answers to the words asked for (`asked`, as `foldName` makes them): 3 when it is
 * those words, 2 when it starts with them, 1 when each of them starts a word of it ("praha 10" is in
 * "Praha 10"; "new yo" in "New York City"), and 0 when not.
 */
function nameScore(name: string, asked: string, askedWords: readonly string[]): number {
  if (name === asked) return 3;
  if (name.startsWith(asked)) return 2;
  const words = wordsOf(name);
  return askedWords.every((word) => words.some((each) => each.startsWith(word))) ? 1 : 0;
}

/** The fewest characters a search must have before it looks for towns: one letter matches too many. */
export const TOWN_SEARCH_MIN = 2;

/** English order for names that score the same and have as many places. */
const collator = new Intl.Collator("en");

/**
 * A search of `cities` for the search's Towns, which folds each town's names once: called with the
 * words `q`, the towns they name, each word the start of a word of the town's name, of its label
 * (`label`), or of one of its other names. Best first: the town that is the words, then one whose name
 * starts with them, then one that has them; at each, a match of a name the town is shown by before a
 * match of another name; then the town with more places; at most `limit`. Nothing for fewer than
 * `TOWN_SEARCH_MIN` characters.
 */
export function townFinder(cities: readonly City[], label: (city: City) => string): (q: string, limit: number) => City[] {
  const entries = cities.map((city) => ({
    city,
    shown: [...new Set([foldName(city.name), foldName(label(city))])],
    other: city.aliases ?? [],
  }));
  return (q, limit) => {
    const asked = foldName(q);
    const askedWords = wordsOf(asked);
    if (asked.length < TOWN_SEARCH_MIN || askedWords.length === 0 || !(limit > 0)) return [];
    const found: { city: City; score: number }[] = [];
    for (const { city, shown, other } of entries) {
      let byShown = 0;
      for (const name of shown) byShown = Math.max(byShown, nameScore(name, asked, askedWords));
      let byOther = 0;
      for (const name of other) byOther = Math.max(byOther, nameScore(name, asked, askedWords));
      const best = Math.max(byShown, byOther);
      // A name the town is shown by wins a tie with another name.
      if (best > 0) found.push({ city, score: best * 2 + (byShown === best ? 1 : 0) });
    }
    return found
      .sort((a, b) => b.score - a.score || b.city.count - a.city.count || collator.compare(a.city.name, b.city.name))
      .slice(0, limit)
      .map(({ city }) => city);
  };
}
