import type { JSX } from "react";

import { copy } from "../copy/en.ts";

/**
 * Words for a screen reader alone, after a link's own: a space, then them. The space is a text node
 * of its own, outside the hidden words, so the link's name reads "Website motya.pt", not "Websitemotya.pt".
 */
export function Unseen({ text }: { text: string }): JSX.Element {
  return (
    <>
      {" "}
      <span className="sr-only">{text}</span>
    </>
  );
}

/** After the words of a link that opens a new tab, for a screen reader: "(opens in a new tab)". The one place the app says it. */
export function NewTabHint(): JSX.Element {
  return <Unseen text={copy.common.newTab} />;
}
