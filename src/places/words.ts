/*
 * The words of a name written without spaces between them. Thai, Lao, Khmer, Burmese, Chinese and
 * Japanese run their words together, so the search, which splits a name at spaces and punctuation and
 * finds it by the start of a part, could find "ร้านก๋วยเตี๋ยวแม่มาลี" (shop, noodles, mother, Mali)
 * only by "ร้าน…". The browser's word breaker (Intl.Segmenter) knows where each word starts.
 */

/** The scripts written without spaces, each with the language whose words the breaker looks for in it. */
const UNSPACED: ReadonlyArray<readonly [script: RegExp, locale: string]> = [
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Lao}/u, "lo"],
  [/\p{Script=Khmer}/u, "km"],
  [/\p{Script=Myanmar}/u, "my"],
  // Kana make it Japanese; Chinese characters alone are read as Chinese.
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja"],
  [/\p{Script=Han}/u, "zh"],
];

/** Any of those scripts: one test, so a part in a script written with spaces is passed over at once. */
const ANY_UNSPACED = new RegExp(UNSPACED.map(([script]) => script.source).join("|"), "u");

const breakers = new Map<string, Intl.Segmenter>();

/** The word breaker for `locale`, made once; undefined where the browser has none. */
function breakerFor(locale: string): Intl.Segmenter | undefined {
  // Asked each time, not once: a browser without it has none, and a test takes it away.
  if (typeof Intl.Segmenter !== "function") return undefined;
  let breaker = breakers.get(locale);
  if (breaker === undefined) {
    breaker = new Intl.Segmenter(locale, { granularity: "word" });
    breakers.set(locale, breaker);
  }
  return breaker;
}

/**
 * The rest of `run`, one part of a name with no space or punctuation in it, from each of its words
 * but the first: "ก๋วยเตี๋ยวแม่มาลี", "แม่มาลี" and "มาลี" for "ร้านก๋วยเตี๋ยวแม่มาลี". The search
 * finds a name by the start of a part, so these make each word of the name, and each run of its words,
 * a start. Nothing for a part in a script written with spaces, or where the browser has no word breaker.
 */
export function laterWordStarts(run: string): string[] {
  if (!ANY_UNSPACED.test(run)) return [];
  const locale = UNSPACED.find(([script]) => script.test(run))?.[1];
  const breaker = locale === undefined ? undefined : breakerFor(locale);
  if (breaker === undefined) return [];
  const starts: string[] = [];
  for (const { index, isWordLike } of breaker.segment(run)) if (isWordLike && index > 0) starts.push(run.slice(index));
  return starts;
}
