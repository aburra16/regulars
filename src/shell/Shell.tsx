import type { JSX } from "react";
import { Outlet, ScrollRestoration, useMatches } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { type PlacesValue, usePlaces } from "../places/store.tsx";
import { Banner, LoadFailed, PageMessage } from "../ui/Banner.tsx";
import { ViewProvider } from "../view/ViewProvider.tsx";
import { PhoneTop } from "./PhoneTop.tsx";
import { scrollKey } from "./scrollKey.ts";
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
  /**
   * The page fills the window, and what is in it scrolls inside it, not the window: a map, which
   * takes what the top and the tabs leave. `always`, or `wide` for the desktop's layout only.
   * Default: the page is as tall as it is, and the window scrolls.
   */
  fill?: "always" | "wide";
}

function useChrome(): Omit<Required<Chrome>, "fill"> & Pick<Chrome, "fill"> {
  const handle = useMatches().at(-1)?.handle as Chrome | undefined;
  return {
    tabs: handle?.tabs ?? false,
    near: handle?.near ?? false,
    topBar: handle?.topBar ?? true,
    needsPlaces: handle?.needsPlaces ?? true,
    fill: handle?.fill,
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
  const fill = chrome.fill === "always" || (chrome.fill === "wide" && wide);

  let content: JSX.Element;
  if (state.page === "failed") {
    content = <LoadFailed retry={places.retry} />;
  } else if (state.page === "loading") {
    content = <PageMessage>{copy.load.loading}</PageMessage>;
  } else {
    content = <Outlet />;
  }

  return (
    <div className={`flex flex-col bg-ground font-text text-ink ${fill ? "h-dvh" : "min-h-dvh"}`}>
      {wide ? chrome.topBar && <TopBar /> : chrome.near && <PhoneTop />}
      {/* Always there, so a screen reader announces the line when it comes. Empty, it takes no room. */}
      <div role="status" className="px-gutter-phone wide:px-gutter-desktop *:mt-3">
        {state.page === undefined && state.banner !== undefined && <Banner>{state.banner}</Banner>}
      </div>
      <main className={`flex min-w-0 flex-1 flex-col ${fill ? "min-h-0" : ""}`}>{content}</main>
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
      <ScrollRestoration getKey={scrollKey} />
    </ViewProvider>
  );
}
