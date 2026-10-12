import { type JSX, useContext } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { PageMessage, primaryButton } from "../ui/Banner.tsx";
import { PageFoot, ShellFoot } from "./PageFoot.tsx";
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
 *
 * Under it, the foot the shell did not draw (`ShellFoot`): the shell draws none for a page that fills
 * the window, as that page sees to the line itself, and the page that broke is not there to. So this
 * one has the line too, once: where the shell draws its foot, it draws none.
 */
export function PageError(): JSX.Element {
  const shellFoot = useContext(ShellFoot);
  return (
    <>
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
      {!shellFoot && <PageFoot />}
    </>
  );
}

/**
 * The shell itself broke: the same words on a page of their own, with nothing of the shell around
 * them but the foot it would have drawn.
 */
export function ShellError(): JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-ground font-text text-ink">
      <main className="flex flex-1 flex-col">
        <PageError />
      </main>
      <PageFoot />
    </div>
  );
}
