/** U+2011, a hyphen the line does not break at. */
const NO_BREAK_HYPHEN = "‑";

/**
 * An address as a page shows it: a hyphen between two digits, as in a postcode ("9000-082"), is one
 * the line does not break at, so the postcode stays whole on its line. Other hyphens are as written.
 */
export function unbrokenPostcodes(text: string): string {
  return text.replace(/(\d)-(?=\d)/g, `$1${NO_BREAK_HYPHEN}`);
}
