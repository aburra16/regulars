import type { JSX } from "react";

/** A run of digits joined by hyphens, as a postcode is ("9000-082"): the digits on both sides of each hyphen are in it. */
const POSTCODE = /(\d+(?:-\d+)+)/;

/**
 * An address as a page shows it, as written: a hyphen between two digits, as in a postcode
 * ("9000-082"), has the whole run of digits in an element the line does not break in, so the
 * postcode stays whole on its line. The hyphen stays a plain "-": the special hyphen made for this
 * (U+2011) is in none of the fonts the app loads, so it would be drawn in another face, and copied.
 */
export function Address({ text }: { text: string }): JSX.Element {
  // Split on a group keeps what matched, so every odd part is a postcode.
  const parts = text.split(POSTCODE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
