// First: what the browser may lack, in place before any module that uses it is loaded.
import "./polyfills.ts";
// The display face as the screens load it: variable, with its optical-size axis (opsz 12 to 96) and
// the weights 700 and 800 inside its range.
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/600.css";
import "@fontsource/noto-sans/700.css";
// A Noto Sans for each script the places' names are in, beyond what Noto Sans has: each face
// declares the characters it covers (unicode-range), so a page downloads one only for a name in it.
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/700.css";
import "@fontsource/noto-sans-kr/400.css";
import "@fontsource/noto-sans-kr/700.css";
import "@fontsource/noto-sans-thai/400.css";
import "@fontsource/noto-sans-thai/700.css";
import "@fontsource/noto-sans-lao/400.css";
import "@fontsource/noto-sans-lao/700.css";
import "@fontsource/noto-sans-arabic/400.css";
import "@fontsource/noto-sans-arabic/700.css";
import "./styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { HereProvider } from "./location/HereProvider.tsx";
import { PlacesProvider } from "./places/store.tsx";
import { routes } from "./routes.tsx";
import { ScoresProvider } from "./score/ScoresProvider.tsx";
import { forgetScrollOfFreshVisit } from "./shell/scrollKey.ts";
import { APP_ROOT_ID } from "./ui/lockPage.ts";

const root = document.getElementById(APP_ROOT_ID);
if (!root) throw new Error(`Missing #${APP_ROOT_ID} element in index.html`);

// A page opened afresh opens where its address says, not where an earlier visit in this tab left it.
forgetScrollOfFreshVisit();
const router = createBrowserRouter(routes);

// The places load once for the whole app; the reviews, ranks and names of the places that pages ask
// about are read once a session (nothing until a page asks); where the places are near is named from
// their towns; the pages, and the shell around them, come from the router.
createRoot(root).render(
  <StrictMode>
    <PlacesProvider>
      <ScoresProvider>
        <HereProvider>
          <RouterProvider router={router} />
        </HereProvider>
      </ScoresProvider>
    </PlacesProvider>
  </StrictMode>,
);
