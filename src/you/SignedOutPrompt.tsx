import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { primaryButton } from "../ui/Banner.tsx";

/**
 * Saved and You, before signing in opens (neither is drawn signed out): the page's name, a sentence
 * that says what signing in is for, and the button that goes to the sign-in page, which can bring the
 * person back here. When signing in opens, the lists and the person's own page take this place.
 */
export function SignedOutPrompt({ page }: { page: "saved" | "you" }): JSX.Element {
  useDocumentTitle(copy.titles[page]);
  const location = useLocation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-gutter-phone py-16 text-center wide:px-gutter-desktop">
      <h1 className="m-0 font-display text-display-phone font-extrabold tracking-display wide:text-display-desktop">
        {copy.pages[page]}
      </h1>
      <p className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">{copy.saved.signedOut}</p>
      <Link to="/signin" state={{ from: location }} className={primaryButton}>
        {copy.signin.button}
      </Link>
    </div>
  );
}
