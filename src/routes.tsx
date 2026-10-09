import type { JSX } from "react";
import { Navigate, type RouteObject } from "react-router-dom";

import { AboutPage } from "./about/AboutPage.tsx";
import { ChainPage } from "./chain/ChainPage.tsx";
import { WHY_PATH } from "./circle/paths.ts";
import { WhyPage } from "./circle/WhyPage.tsx";
import { DeskExplore } from "./explore/DeskExplore.tsx";
import { ExploreList } from "./explore/ExploreList.tsx";
import { MapPage } from "./explore/MapPage.tsx";
import { PlacePage } from "./place/PlacePage.tsx";
import { RecentPage } from "./recent/RecentPage.tsx";
import { ReviewRoute } from "./review/ReviewPage.tsx";
import { FiltersPage } from "./search/FiltersPage.tsx";
import { SearchPage } from "./search/SearchPage.tsx";
import { NotFound, PageError } from "./shell/PageError.tsx";
import { type Chrome, Shell } from "./shell/Shell.tsx";
import { useWide } from "./shell/useWide.ts";
import { SignInPage } from "./signin/SignInPage.tsx";
import { SavedPage, YouPage } from "./you/YouPage.tsx";

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
          // ?q=&open=&kinds=&within=&sort=. On a desktop, the results are in Explore's layout, beside the map.
          { path: "search", element: <SearchPage />, handle: chrome({ fill: "wide" }) },
          { path: "filters", element: <FiltersPage /> },
          // Trending: the newest reviews from the people behind the view's ratings, everywhere (Avi,
          // 2026-10-08; decision 31). Its code keeps the name the list had: recent.
          { path: "trending", element: <RecentPage />, handle: chrome({ tabs: true }) },
          // Its address before decision 31. A link to it goes on working, and Back skips it.
          { path: "recent", element: <Navigate to="/trending" replace />, handle: chrome({ tabs: true, needsPlaces: false }) },
          // Its child is the review form: a page of its own on a phone, a dialog over the place on a desktop.
          { path: "place/:d", element: <PlacePage />, children: [{ path: "review", element: <ReviewRoute /> }] },
          { path: "chain/:key", element: <ChainPage /> },
          // The words are there at once; the figures come when the places do.
          { path: "about", element: <AboutPage />, handle: chrome({ needsPlaces: false }) },
          // Why you see what you see: "How this works", beside the toggle, links here. It shows no places.
          { path: WHY_PATH.slice(1), element: <WhyPage />, handle: chrome({ needsPlaces: false }) },
          { path: "signin", element: <SignInPage />, handle: chrome({ topBar: false, needsPlaces: false }) },
          // Both ask the person to sign in, until they have. Saved is in no tab or bar until saved
          // lists open (config.features.saved); a link to it still opens it.
          { path: "saved", element: <SavedPage />, handle: chrome({ tabs: true, needsPlaces: false }) },
          { path: "you", element: <YouPage />, handle: chrome({ tabs: true, needsPlaces: false }) },
          { path: "*", element: <NotFound />, handle: chrome({ needsPlaces: false }) },
        ],
      },
    ],
  },
];
