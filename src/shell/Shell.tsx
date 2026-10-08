import type { JSX } from "react";
import { Outlet, ScrollRestoration, useMatches } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { type PlacesValue, usePlaces } from "../places/store.tsx";
import { Banner, PageMessage, primaryButton } from "../ui/Banner.tsx";
import { ViewProvider } from "../view/ViewProvider.tsx";
import { PhoneTop } from "./PhoneTop.tsx";
import { TabBar } from "./TabBar.tsx";
import { TopBar } from "./TopBar.tsx";
import { useOnline } from "./useOnline.ts";
import { useWide } from "./useWide.ts";

/** What a page has around it. Each route sets it as its `handle`; anything left out takes the default. */
export interface Chrome {
  /** Phone: the tabs at the foot of the screen. Default false: a page opened from a list has a way back instead. */
  tabs?: boolean;
  /** Phone: the wordmark and where the places are near, at the top (Explore only). Default false. */
  near?: boolean;
  /** Desktop: the one top bar. Default true; sign in draws its own dark page. */
  topBar?: boolean;
  /** The page shows places, so it waits for them, and says how they loaded. Default true. */
  needsPlaces?: boolean;
}

function useChrome(): Required<Chrome> {
  const handle = useMatches().at(-1)?.handle as Chrome | undefined;
  return {
    tabs: handle?.tabs ?? false,
    near: handle?.near ?? false,
    topBar: handle?.topBar ?? true,
    needsPlaces: handle?.needsPlaces ?? true,
  };
}

/**
 * What the places allow the page to show: the page itself, perhaps under a quiet line, or a
 * message in its place. No places yet: a calm loading line, then the error with Try again if
 * they could not be loaded. A list that may be short says nothing, to keep the page calm.
 */
function loadState(
  { status, places, source, error }: PlacesValue,
  online: boolean,
): { page: "loading" | "failed" } | { page?: undefined; banner?: string } {
  if (places.length === 0) return { page: status === "error" ? "failed" : "loading" };
  // Offline with places that came from this device's saved copy: say so. Otherwise the places
  // on screen are fresh, and all there is to say is that the connection is gone.
  if (!online) return { banner: source === "cache" ? copy.offline : copy.offlineNoCache };
  if (source === "cache" && error !== undefined) return { banner: copy.load.cached };
  return {};
}

function Frame(): JSX.Element {
  const wide = useWide();
  const chrome = useChrome();
  const places = usePlaces();
  const online = useOnline();
  const state = chrome.needsPlaces ? loadState(places, online) : {};

  let content: JSX.Element;
  if (state.page === "failed") {
    content = (
      <PageMessage
        alert
        action={
          <button type="button" onClick={places.retry} className={primaryButton}>
            {copy.load.retry}
          </button>
        }
      >
        {copy.load.failed}
      </PageMessage>
    );
  } else if (state.page === "loading") {
    content = <PageMessage>{copy.load.loading}</PageMessage>;
  } else {
    content = <Outlet />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ground font-text text-ink">
      {wide ? chrome.topBar && <TopBar /> : chrome.near && <PhoneTop />}
      {/* Always there, so a screen reader announces the line when it comes. Empty, it takes no room. */}
      <div role="status" className="px-gutter-phone wide:px-gutter-desktop *:mt-3">
        {state.page === undefined && state.banner !== undefined && <Banner>{state.banner}</Banner>}
      </div>
      <main className="flex min-w-0 flex-1 flex-col">{content}</main>
      {!wide && chrome.tabs && <TabBar />}
    </div>
  );
}

/**
 * The app around every page: the desktop's top bar or the phone's tabs, chosen by the window's
 * width, the load banners, and the page. It is the root route's element; the page is its outlet.
 */
export function Shell(): JSX.Element {
  return (
    <ViewProvider>
      <Frame />
      {/* A new page opens at its top; Back returns to where the person was. */}
      <ScrollRestoration />
    </ViewProvider>
  );
}
