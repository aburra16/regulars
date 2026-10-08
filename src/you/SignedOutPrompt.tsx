import { type JSX, type ReactNode, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { ThemeSwitch } from "../theme/ThemeSwitch.tsx";
import { primaryButton } from "../ui/Banner.tsx";

/**
 * Saved or You with nothing of the person's to show: the page's name, a sentence of its own, and what
 * the person can do, if anything. You also has the page's settings at its foot, which are the
 * device's and need no sign in: dark mode, which a phone has nowhere else but Explore's top.
 * `focusHeading` puts the focus on the name, for when what had it is gone.
 */
function Prompt({
  page,
  sentence,
  action,
  focusHeading = false,
}: {
  page: "saved" | "you";
  sentence: string;
  action?: ReactNode;
  focusHeading?: boolean;
}): JSX.Element {
  useDocumentTitle(copy.titles[page]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus({ preventScroll: true });
  }, [focusHeading]);
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-gutter-phone py-16 text-center wide:px-gutter-desktop">
        <h1
          ref={heading}
          tabIndex={-1}
          className="m-0 font-display text-display-phone font-extrabold tracking-display outline-none wide:text-display-desktop"
        >
          {copy.pages[page]}
        </h1>
        <p className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">{sentence}</p>
        {action}
      </div>
      {page === "you" && (
        <div className="mx-auto w-full max-w-[480px] px-gutter-phone pb-8 wide:px-gutter-desktop">
          <ThemeSwitch />
        </div>
      )}
    </>
  );
}

/**
 * Saved and You before sign in (the design draws neither signed out): a sentence that says what
 * signing in is for there, and the button that goes to the sign-in page, which can bring the person
 * back here.
 */
export function SignedOutPrompt({ page, focusHeading }: { page: "saved" | "you"; focusHeading?: boolean }): JSX.Element {
  const location = useLocation();
  return (
    <Prompt
      page={page}
      sentence={copy[page].signedOut}
      focusHeading={focusHeading}
      action={
        <Link to="/signin" state={{ from: location }} className={primaryButton}>
          {copy.signin.button}
        </Link>
      }
    />
  );
}

/** Saved after sign in, before saving places opens: it says so. */
export function SavedSoon(): JSX.Element {
  return <Prompt page="saved" sentence={copy.saved.soon} />;
}
