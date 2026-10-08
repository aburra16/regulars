/** Hiragana, katakana (and their extensions), and half-width katakana: the marks of Japanese writing. */
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/u;

/** Each script with a language to name it for: the first that a name has is the one. */
const SCRIPTS: ReadonlyArray<readonly [lang: string, script: RegExp]> = [
  // Kana only occurs in Japanese, so it settles a name that also holds kanji.
  ["ja", KANA],
  ["ko", /\p{Script=Hangul}/u],
  // Han with no kana and no Hangul: Chinese is the likeliest, though kanji-only Japanese names exist.
  ["zh", /\p{Script=Han}/u],
  ["th", /\p{Script=Thai}/u],
  ["ar", /\p{Script=Arabic}/u],
  ["ru", /\p{Script=Cyrillic}/u],
];

/**
 * The language to mark a name with (`lang="ja"`), from the script it is written in, or undefined
 * for a name that needs none: Latin, which the page's own language covers. The mark lets the
 * browser choose the right face for characters that several languages share. It is a guess from
 * the script, not a detection of the language: Han with no kana reads as Chinese.
 */
export function scriptLang(name: string): string | undefined {
  return SCRIPTS.find(([, script]) => script.test(name))?.[0];
}
