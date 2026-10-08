import type { RouteObject } from "react-router-dom";

import {
  AboutPage,
  ChainPage,
  ExplorePage,
  FiltersPage,
  MapPage,
  PlacePage,
  SavedPage,
  SearchPage,
  SignInPage,
  YouPage,
} from "./pages/placeholders.tsx";
import { NotFound, PageError } from "./shell/PageError.tsx";
import { type Chrome, Shell } from "./shell/Shell.tsx";

const chrome = (value: Chrome): Chrome => value;

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
          { index: true, element: <ExplorePage />, handle: chrome({ tabs: true, near: true }) },
          { path: "map", element: <MapPage />, handle: chrome({ tabs: true }) },
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
