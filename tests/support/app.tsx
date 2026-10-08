import type { NostrEvent, NRelay } from "@nostrify/nostrify";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, type InitialEntry, RouterProvider } from "react-router-dom";
import { expect } from "vitest";

import { AccountProvider } from "../../src/account/AccountProvider";
import { CircleProvider, ForgetCircleOnSignOut } from "../../src/circle/CircleProvider";
import { copy } from "../../src/copy/en";
import { HereProvider } from "../../src/location/HereProvider";
import type { RelayReader, RelayWriter } from "../../src/nostr/events";
import { writeSaved } from "../../src/places/cache";
import { PlacesProvider, usePlaces } from "../../src/places/store";
import { routes } from "../../src/routes";
import { ScoresProvider } from "../../src/score/ScoresProvider";
import { createMemoryReader } from "./memoryReader";

export const PHONE = 390;
export const DESKTOP = 1360;

let width = PHONE;

/** What hears each query list change: `resizeTo` calls them. */
const onChanges = new Set<() => void>();

/** Makes the window as wide as `px`, for `useWide` and every `wide:` rule that asks `matchMedia`. */
export function setWidth(px: number): void {
  width = px;
  onChanges.clear();
  window.matchMedia = ((query: string) => {
    const min = Number(/\(min-width:\s*(\d+)px\)/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      get matches() {
        return width >= min;
      },
      addEventListener: (_: string, onChange: () => void) => onChanges.add(onChange),
      removeEventListener: (_: string, onChange: () => void) => onChanges.delete(onChange),
    };
  }) as unknown as typeof window.matchMedia;
}

/**
 * Makes the open page's window as wide as `px` and tells what listens, as a browser does when the
 * window is resized or a phone is turned: a page that crosses 900 px is laid out the other way.
 */
export function resizeTo(px: number): void {
  width = px;
  for (const onChange of [...onChanges]) onChange();
}

/** Puts the window back as jsdom has it (no `matchMedia`, so the phone's layout). Call it after each test. */
export function resetWidth(): void {
  Reflect.deleteProperty(window, "matchMedia");
}

export interface OpenOptions {
  /** The window's width. Default: a phone's. */
  px?: number;
  /** The place events the relay has. Default: none, so the caller must give them. */
  events: NostrEvent[];
  /** The history, ending at the page that is open. Default: `[path]`. An entry may carry router state. */
  entries?: InitialEntry[];
  /** How long the relay waits before it answers, in milliseconds. Default: no wait. */
  delayMs?: number;
  /**
   * The reader of each relay the scores store reads (reviews, the house's ranks, names). Default:
   * the app's own, as main.tsx has it; tests open no socket (tests/setup.ts), so pass readers to read.
   */
  readers?: (url: string) => RelayReader;
  /**
   * The writer of each relay a review is sent to. Default: the app's own, which opens a socket
   * (tests/setup.ts forbids it), so pass writers to post.
   */
  writers?: (url: string) => RelayWriter;
  /**
   * The NIP-46 meeting point at each address, for signing in with an app on a phone. Default: the
   * app's own, which opens a socket (tests/setup.ts forbids it), so pass one to connect.
   */
  relays?: (url: string) => NRelay;
}

/**
 * The app at `path`, with the places read from `events`, and its providers as main.tsx has them: the
 * person is signed in if `sessionStorage` says so. It resolves once the page is past the "Finding
 * places" line, which a page that needs no places never shows.
 */
export async function openApp(path: string, { px = PHONE, events, entries, delayMs, readers, writers, relays }: OpenOptions) {
  setWidth(px);
  const initialEntries = entries ?? [path];
  const router = createMemoryRouter(routes, { initialEntries, initialIndex: initialEntries.length - 1 });
  const view = render(
    <PlacesProvider reader={createMemoryReader(events, delayMs === undefined ? {} : { delayMs })}>
      <ScoresProvider readers={readers} writers={writers}>
        <ForgetCircleOnSignOut>
          <AccountProvider relays={relays}>
            <CircleProvider>
              <HereProvider>
                <RouterProvider router={router} />
              </HereProvider>
            </CircleProvider>
          </AccountProvider>
        </ForgetCircleOnSignOut>
      </ScoresProvider>
    </PlacesProvider>,
  );
  await waitFor(() => expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument());
  return { router, ...view };
}

/** What the store holds, as text: how many places and where from. */
function Probe() {
  const { places, source } = usePlaces();
  return <span data-testid="probe">{`${places.length} ${source}`}</span>;
}

/**
 * The app at `path` with `saved` on the device and `latest` from the relay 200 ms later. It resolves
 * once the saved places are on screen and the relay has not answered yet.
 */
export async function openAppWithSaved(path: string, saved: NostrEvent[], latest: NostrEvent[]) {
  await writeSaved({ events: saved, savedAt: Date.now(), complete: true });
  setWidth(PHONE);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <PlacesProvider reader={createMemoryReader(latest, { delayMs: 200 })}>
      <Probe />
      <ScoresProvider>
        <ForgetCircleOnSignOut>
          <AccountProvider>
            <CircleProvider>
              <HereProvider>
                <RouterProvider router={router} />
              </HereProvider>
            </CircleProvider>
          </AccountProvider>
        </ForgetCircleOnSignOut>
      </ScoresProvider>
    </PlacesProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(/^\d+ cache$/));
  return { router, ...view };
}
