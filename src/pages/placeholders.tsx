import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";

/** A page that is not built yet: its heading and its title in the tab, and nothing else. Each later task replaces its own. */
function Placeholder({ page }: { page: "about" | "signin" | "saved" | "you" }): JSX.Element {
  const title = copy.pages[page];
  useDocumentTitle(copy.titles[page]);
  return (
    <div className="px-gutter-phone py-6 wide:px-gutter-desktop">
      <h1 className="m-0 font-display text-display-phone font-extrabold tracking-display wide:text-display-desktop">
        {title}
      </h1>
    </div>
  );
}

export const AboutPage = (): JSX.Element => <Placeholder page="about" />;
export const SignInPage = (): JSX.Element => <Placeholder page="signin" />;
export const SavedPage = (): JSX.Element => <Placeholder page="saved" />;
export const YouPage = (): JSX.Element => <Placeholder page="you" />;
