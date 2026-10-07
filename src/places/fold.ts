/**
 * Text as the search sees it: lower case, with the accents of Latin letters taken off, so "Sao"
 * finds "São". Only the marks in the Combining Diacritical Marks block go. The marks of other
 * scripts stay: taking them off would make ペ the same as ヘ. Text is searched for in this form
 * on both sides, so nobody sees it.
 */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
