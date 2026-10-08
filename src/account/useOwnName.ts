import { copy } from "../copy/en.ts";
import { useNames, useOwnPicture } from "../score/useScore.ts";

/**
 * The name of the person who has signed in, from their profile, as reviewers' names are read (the
 * scores store); undefined until it is known, or when their profile gives none. The store names
 * everyone it has no name for "Someone", which is no name for the person themself: they are "You".
 */
export function useOwnName(pubkey: string): string | undefined {
  const name = useNames([pubkey]).get(pubkey);
  return name === undefined || name === copy.reviews.someone ? undefined : name;
}

/**
 * The name and picture of the person who has signed in, from their profile (`useOwnName`,
 * `useOwnPicture`): each undefined until it is known, or when their profile gives none to show.
 */
export function useOwnProfile(pubkey: string): { name: string | undefined; picture: string | undefined } {
  return { name: useOwnName(pubkey), picture: useOwnPicture(pubkey) };
}

/**
 * The first letter of `name` as the person would write it (a whole character, accents and all), in
 * capitals. A browser without `Intl.Segmenter` (Firefox before 125) takes its first code point.
 */
export function initialOf(name: string): string {
  const first =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next().value?.segment
      : Array.from(name)[0];
  return (first ?? "").toLocaleUpperCase();
}
