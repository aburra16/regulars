import type { JSX } from "react";

/** A run of digits joined by hyphens, as a postcode is ("9000-082"): the digits on both sides of each hyphen are in it. */
const RUN = /(\d+(?:-\d+)+)/;

/**
 * The longest run kept on one line: four parts of up to ten digits each, more than any postcode has.
 * A longer run, as a hostile address could have, is left to wrap as the line's other words do (where
 * the address is drawn, a word too long for its line breaks inside it).
 */
const POSTCODE = /^\d{1,10}(?:-\d{1,10}){1,3}$/;

/**
 * An address as a page shows it, as written: a hyphen between two digits, as in a postcode
 * ("9000-082"), has the whole run of digits in an element the line does not break in, so the
 * postcode stays whole on its line, when the run is no longer than a postcode (`POSTCODE`). The
 * hyphen stays a plain "-": the special hyphen made for this (U+2011) is in none of the fonts the app
 * loads, so it would be drawn in another face, and copied.
 */
export function Address({ text }: { text: string }): JSX.Element {
  // Split on a group keeps what matched, so every odd part is a run of digits and hyphens.
  const parts = text.split(RUN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && POSTCODE.test(part) ? (
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
