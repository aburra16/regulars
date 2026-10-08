// First: what the browser may lack, in place before any module that uses it is loaded.
import "./polyfills.ts";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/bricolage-grotesque/800.css";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/600.css";
import "@fontsource/noto-sans/700.css";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/700.css";
import "./styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { HereProvider } from "./location/HereProvider.tsx";
import { PlacesProvider } from "./places/store.tsx";
import { routes } from "./routes.tsx";
import { APP_ROOT_ID } from "./ui/lockPage.ts";

const root = document.getElementById(APP_ROOT_ID);
if (!root) throw new Error(`Missing #${APP_ROOT_ID} element in index.html`);

const router = createBrowserRouter(routes);

// The places load once for the whole app; where they are near is named from their towns; the
// pages, and the shell around them, come from the router.
createRoot(root).render(
  <StrictMode>
    <PlacesProvider>
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>
    </PlacesProvider>
  </StrictMode>,
);
