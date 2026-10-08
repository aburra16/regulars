import type { JSX } from "react";
import type { RouteObject } from "react-router-dom";

import { DeskExplore } from "./explore/DeskExplore.tsx";
import { ExploreList } from "./explore/ExploreList.tsx";
import { MapPage } from "./explore/MapPage.tsx";
import { AboutPage, ChainPage, SavedPage, SignInPage, YouPage } from "./pages/placeholders.tsx";
import { PlacePage } from "./place/PlacePage.tsx";
import { FiltersPage } from "./search/FiltersPage.tsx";
import { SearchPage } from "./search/SearchPage.tsx";
import { NotFound, PageError } from "./shell/PageError.tsx";
import { type Chrome, Shell } from "./shell/Shell.tsx";
import { useWide } from "./shell/useWide.ts";

const chrome = (value: Chrome): Chrome => value;

/** Explore: the list on a phone, and on a desktop the list beside the map. */
function Explore(): JSX.Element {
  return useWide() ? <DeskExplore /> : <ExploreList />;
}

/**
 * Every page of the app. main.tsx gives them to a browser router; GitHub Pages answers an unknown
 * path with a copy of index.html (404.html), so a link straight to a place loads too. Each route's
 * `handle` says what is around the page (see `Chrome`).
 */
export const routes: RouteObject[] = [
  {
    element: <Shell />,
    // If the shell itself breaks. A page that breaks shows its error inside the shell, below.
    errorElement: <PageError />,
    children: [
      {
        errorElement: <PageError />,
        children: [
          { index: true, element: <Explore />, handle: chrome({ tabs: true, near: true, fill: "wide" }) },
          // On a desktop, Explore has the map: this goes there.
          { path: "map", element: <MapPage />, handle: chrome({ tabs: true, fill: "always" }) },
          // ?q=&open=&kinds=&within=&sort=
          { path: "search", element: <SearchPage /> },
          { path: "filters", element: <FiltersPage /> },
          { path: "place/:d", element: <PlacePage /> },
          { path: "chain/:key", element: <ChainPage /> },
          { path: "about", element: <AboutPage /> },
          { path: "signin", element: <SignInPage />, handle: chrome({ topBar: false, needsPlaces: false }) },
          // Both ask the person to sign in, in M1.
          { path: "saved", element: <SavedPage />, handle: chrome({ tabs: true, needsPlaces: false }) },
          { path: "you", element: <YouPage />, handle: chrome({ tabs: true, needsPlaces: false }) },
          { path: "*", element: <NotFound />, handle: chrome({ needsPlaces: false }) },
        ],
      },
    ],
  },
];
