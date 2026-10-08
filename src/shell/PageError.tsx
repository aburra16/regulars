import type { JSX } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { PageMessage, primaryButton } from "../ui/Banner.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";

/** An address in the app that has no page. It never shows a status code. */
export function NotFound(): JSX.Element {
  useDocumentTitle(copy.titles.missing);
  return (
    <PageMessage
      action={
        <Link to="/" className={primaryButton}>
          {copy.missing.home}
        </Link>
      }
    >
      {copy.missing.text}
    </PageMessage>
  );
}

/**
 * A page that broke while it was drawn, in place of the router's own error screen, which shows the
 * error's message and stack. The error itself goes to the console only.
 */
export function PageError(): JSX.Element {
  return (
    <PageMessage
      alert
      action={
        <Link to="/" className={primaryButton}>
          {copy.broken.home}
        </Link>
      }
    >
      {copy.broken.text}
    </PageMessage>
  );
}
