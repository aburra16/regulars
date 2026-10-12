import type { NostrEvent } from "@nostrify/nostrify";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePlaces } from "../src/places/load";
import raw from "./fixtures/funchal-items.json";
import { openApp, resetWidth } from "./support/app";
import { createMemoryReader } from "./support/memoryReader";

/*
 * The mark that notes what has the focus as a new page goes in (`ArrivalMark`, src/shell/headingFocus.ts)
 * must be drawn before the page: a commit's layout effects run in the order of the tree, so only then
 * does it note the focus before anything of the new page can move it (the search field's autoFocus is
 * one). This watches the order: the mark's layout effect, and the new page's (`useDocumentTitle`, which
 * every page calls), each as the page changes.
 */

/** What ran, in order: "mark" for the mark, "page: <title>" for a page naming itself. */
const order = vi.hoisted(() => [] as string[]);

vi.mock("../src/shell/headingFocus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell/headingFocus")>();
  const { useLayoutEffect } = await import("react");
  const { useLocation } = await import("react-router-dom");
  return {
    ...actual,
    ArrivalMark: (props: Parameters<typeof actual.ArrivalMark>[0]) => {
      const { pathname } = useLocation();
      useLayoutEffect(() => {
        order.push("mark");
      }, [pathname]);
      return actual.ArrivalMark(props);
    },
  };
});

vi.mock("../src/shell/useDocumentTitle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell/useDocumentTitle")>();
  const { useLayoutEffect } = await import("react");
  return {
    ...actual,
    useDocumentTitle: (title: string) => {
      useLayoutEffect(() => {
        order.push(`page: ${title}`);
      }, [title]);
      actual.useDocumentTitle(title);
    },
  };
});

const fixtures: NostrEvent[] = raw;
const PLACES = parsePlaces(fixtures);

afterEach(() => {
  resetWidth();
  order.length = 0;
});

describe("ArrivalMark", () => {
  it("notes the focus before the new page's own layout effects run: it is drawn before the page", async () => {
    const user = userEvent.setup();
    await openApp("/", { events: fixtures, readers: () => createMemoryReader([]) });
    const card = screen.getByRole("main").querySelector<HTMLAnchorElement>('a[href^="/place/"]')!;
    const place = PLACES.find((each) => card.getAttribute("href") === `/place/${encodeURIComponent(each.d)}`)!;
    order.length = 0;
    await user.click(card);
    await screen.findByRole("heading", { level: 1, name: place.name });

    const mark = order.indexOf("mark");
    const page = order.findIndex((each) => each.startsWith("page: ") && each.includes(place.name));
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(page).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(page);
  });
});
