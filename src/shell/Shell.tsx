import { type JSX, useRef } from "react";
import { Outlet, ScrollRestoration, useMatches } from "react-router-dom";

import { CircleDoorProvider } from "../circle/CircleDoor.tsx";
import { CircleBar, CircleNewsProvider } from "../circle/CircleNews.tsx";
import { useClearUpdateOffWhy } from "../circle/leaveWhy.ts";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
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
 * they could not be loaded; or, when the browser says it has no connection, that it is offline,
 * at once (the places load again when it is back: see PlacesProvider). With places, the loading
 * line stays while where they are near is still `settling`: the device the browser already allows
 * is answering, for a moment at most, so the list does not open on a guess and jump. A list that
 * may be short says nothing, to keep the page calm.
 */
function loadState(
  { status, places, source, error }: PlacesValue,
  online: boolean,
  settling: boolean,
): { page: "loading" | "failed" | "offline" } | { page?: undefined; banner?: string } {
  if (places.length === 0) return { page: !online ? "offline" : status === "error" ? "failed" : "loading" };
  if (settling) return { page: "loading" };
  // Offline with places that came from this device's saved copy: say so. Otherwise the places
  // on screen are fresh, and all there is to say is that the connection is gone.
  if (!online) return { banner: source === "cache" ? copy.offline : copy.offlineNoCache };
  if (source === "cache" && error !== undefined) return { banner: copy.load.cached };
  return {};
}

function Frame(): JSX.Element {
  // Update now's last word is for the Why page's visit it was said in.
  useClearUpdateOffWhy();
  const wide = useWide();
  const chrome = useChrome();
  const places = usePlaces();
  const online = useOnline();
  const settling = useHere().settling === true;
  const state = chrome.needsPlaces ? loadState(places, online, settling) : {};
  const fill = chrome.fill === "always" || (chrome.fill === "wide" && wide);
  // The page: where the focus goes when the bar is put away and what had it before has gone.
  const main = useRef<HTMLElement>(null);

  let content: JSX.Element;
  if (state.page === "failed") {
    content = <LoadFailed retry={places.retry} />;
  } else if (state.page === "offline") {
    content = <PageMessage>{copy.load.offline}</PageMessage>;
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
      {/* No ring: it holds the focus only for a moment, given back from the bar (src/circle/CircleNews.tsx). */}
      <main ref={main} className={`flex min-w-0 flex-1 flex-col outline-none ${fill ? "min-h-0" : ""}`}>
        {content}
      </main>
      {!wide && chrome.tabs && <TabBar />}
      {/* What the person is told of their circle, over the foot of every page; its status always there. */}
      <CircleBar aboveTabs={!wide && chrome.tabs} main={main} />
    </div>
  );
}

/**
 * The app around every page: the desktop's top bar or the phone's tabs, chosen by the window's
 * width, the load banners, the page, and the bar that tells the person of their circle. It is the root
 * route's element; the page is its outlet. The view, the door to My circle and what the person is told
 * of their circle are the same for the top bar's toggle and the page's, from one page to the next.
 */
export function Shell(): JSX.Element {
  return (
    <ViewProvider>
      <CircleDoorProvider>
        <CircleNewsProvider>
          <Frame />
        </CircleNewsProvider>
        {/* A new page opens at its top; Back returns to where the person was. */}
        <ScrollRestoration getKey={scrollKey} />
      </CircleDoorProvider>
    </ViewProvider>
  );
}
