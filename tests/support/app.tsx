import type { NostrEvent } from "@nostrify/nostrify";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, type InitialEntry, RouterProvider } from "react-router-dom";
import { expect } from "vitest";

import { copy } from "../../src/copy/en";
import { HereProvider } from "../../src/location/HereProvider";
import { writeSaved } from "../../src/places/cache";
import { PlacesProvider, usePlaces } from "../../src/places/store";
import { routes } from "../../src/routes";
import { createMemoryReader } from "./memoryReader";

export const PHONE = 390;
export const DESKTOP = 1360;

let width = PHONE;

/** Makes the window as wide as `px`, for `useWide` and every `wide:` rule that asks `matchMedia`. */
export function setWidth(px: number): void {
  width = px;
  window.matchMedia = ((query: string) => {
    const min = Number(/\(min-width:\s*(\d+)px\)/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      get matches() {
        return width >= min;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }) as unknown as typeof window.matchMedia;
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
}

/**
 * The app at `path`, with the places read from `events`. It resolves once the page is past the
 * "Finding places" line, which a page that needs no places never shows.
 */
export async function openApp(path: string, { px = PHONE, events, entries }: OpenOptions) {
  setWidth(px);
  const initialEntries = entries ?? [path];
  const router = createMemoryRouter(routes, { initialEntries, initialIndex: initialEntries.length - 1 });
  const view = render(
    <PlacesProvider reader={createMemoryReader(events)}>
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>
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
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>
    </PlacesProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(/^\d+ cache$/));
  return { router, ...view };
}
