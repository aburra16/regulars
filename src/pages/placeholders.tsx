import type { JSX } from "react";

import { copy } from "../copy/en.ts";

/** A page that is not built yet: its title, and nothing else. Each later task replaces its own. */
function Placeholder({ title }: { title: string }): JSX.Element {
  return (
    <div className="px-gutter-phone py-6 wide:px-gutter-desktop">
      <h1 className="m-0 font-display text-display-phone font-extrabold tracking-display wide:text-display-desktop">
        {title}
      </h1>
    </div>
  );
}

export const ExplorePage = (): JSX.Element => <Placeholder title={copy.pages.explore} />;
export const MapPage = (): JSX.Element => <Placeholder title={copy.pages.map} />;
export const SearchPage = (): JSX.Element => <Placeholder title={copy.pages.search} />;
export const FiltersPage = (): JSX.Element => <Placeholder title={copy.pages.filters} />;
export const PlacePage = (): JSX.Element => <Placeholder title={copy.pages.place} />;
export const ChainPage = (): JSX.Element => <Placeholder title={copy.pages.chain} />;
export const AboutPage = (): JSX.Element => <Placeholder title={copy.pages.about} />;
export const SignInPage = (): JSX.Element => <Placeholder title={copy.pages.signin} />;
export const SavedPage = (): JSX.Element => <Placeholder title={copy.pages.saved} />;
export const YouPage = (): JSX.Element => <Placeholder title={copy.pages.you} />;
