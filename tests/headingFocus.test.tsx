import type { NostrEvent } from "@nostrify/nostrify";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../src/copy/en";
import { parsePlaces } from "../src/places/load";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { createMemoryReader } from "./support/memoryReader";

/*
 * Where the focus goes after the person goes to another page (a new pathname): to the new page's main
 * heading, for a screen reader, without scrolling; not on the first load, and not where the new page
 * puts the focus itself. The relays are held in memory; nothing opens a socket.
 */

const fixtures: NostrEvent[] = raw;
const PLACES = parsePlaces(fixtures);
/** Every relay the scores store reads, empty: no reviews, ranks or names. */
const readers = () => createMemoryReader([]);
const open = (path: string, px?: number) => openApp(path, { events: fixtures, readers, ...(px === undefined ? {} : { px }) });

/** The page's main heading. */
const pageHeading = () => within(screen.getByRole("main")).getByRole("heading", { level: 1 });
/** The cards Explore lists, each a link to its place. */
const cards = () => [...screen.getByRole("main").querySelectorAll<HTMLAnchorElement>('a[href^="/place/"]')];
/** The name of the place a link to its page opens. */
const placeOf = (link: HTMLAnchorElement) => PLACES.find((place) => link.getAttribute("href") === `/place/${encodeURIComponent(place.d)}`)!;

afterEach(() => {
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "scrollY");
});

describe("the focus after going to another page", () => {
  it("goes to the place's name when a card on Explore opens it, without scrolling", async () => {
    const user = userEvent.setup();
    await open("/");
    const card = cards()[0]!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(card);

    const name = await screen.findByRole("heading", { level: 1, name: placeOf(card).name });
    expect(name).toHaveFocus();
    // Focusable only from code, and drawn with no ring: it is not a control.
    expect(name).toHaveAttribute("tabindex", "-1");
    expect(name).toHaveClass("outline-none");
    expect(focus.mock.contexts.at(-1)).toBe(name);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("goes to Explore's heading on Back from the place, and leaves the scroll where the router puts it back", async () => {
    const user = userEvent.setup();
    await open("/");
    // Explore was scrolled down when the card was pressed.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
    const card = cards()[3]!;
    await user.click(card);
    expect(await screen.findByRole("heading", { level: 1, name: placeOf(card).name })).toHaveFocus();
    const scrollTo = vi.spyOn(window, "scrollTo");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(screen.getByRole("link", { name: copy.place.back }));

    await waitFor(() => expect(pageHeading()).toHaveTextContent(copy.pages.explore));
    expect(pageHeading()).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    // Back puts the page where it was, and nothing scrolls it after.
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });

  it("goes to the heading of a tab's page, from the tab, which stays", async () => {
    const user = userEvent.setup();
    await open("/");
    await user.click(within(screen.getByRole("navigation", { name: copy.nav.label })).getByRole("link", { name: copy.nav.recent }));
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.recent })).toHaveFocus();
  });

  it("is left alone on the first load, and on the first load's own redirect (an old link to Recent)", async () => {
    await open("/");
    expect(document.body).toHaveFocus();
    resetWidth();
    const { router, unmount } = await open("/recent");
    await waitFor(() => expect(router.state.location.pathname).toBe("/trending"));
    expect(await screen.findByRole("heading", { level: 1, name: copy.pages.recent })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    unmount();
  });

  it("is left where the new page puts it: in the phone's search field, opened from Explore", async () => {
    const user = userEvent.setup();
    await open("/");
    await user.click(screen.getByRole("link", { name: /Tacos, coffee, a restaurant name/ }));
    expect(await screen.findByRole("searchbox", { name: copy.search.label })).toHaveFocus();
  });

  it("is left in the desktop's search field, where the person is typing, as the results open", async () => {
    const user = userEvent.setup();
    const { router } = await open("/", DESKTOP);
    const field = within(screen.getByRole("search")).getByRole("searchbox", { name: copy.search.label });
    await user.click(field);
    await user.keyboard("cafe{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    expect(field).toHaveFocus();
  });
});
