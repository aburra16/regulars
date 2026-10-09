import type { NostrEvent } from "@nostrify/nostrify";
import { render, screen, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocationRow } from "../src/chain/LocationRow";
import { copy } from "../src/copy/en";
import { openState } from "../src/places/hours";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { PlaceCard } from "../src/ui/PlaceCard";
import { PlaceRow } from "../src/ui/PlaceRow";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";

/*
 * Opening hours in colour (Avi, 2026-10-09), wherever the hours are a line: the words that say whether
 * a place is open, and only they, are red when it is closed (the accent), green when it is open, and
 * amber when it closes within 45 minutes, which they say too: "Closing soon · 11 pm". The words say
 * which already, so the colour is never the only sign. The week's table on the place page stays as it is.
 */

const fixtures: NostrEvent[] = raw;
const JACAFE_D = "osm-node-11330857543";
const jacafe = parsePlaces(fixtures).find((each) => each.d === JACAFE_D)!;

/** Open from 11 am to 11 pm every day. Funchal, on Wednesday 7 October 2026, is on UTC+1. */
const ELEVEN = "Mo-Su 11:00-23:00";
const at = (iso: string) => new Date(iso);
/** 09:00 in Funchal: closed, opening at 11 am. */
const CLOSED = at("2026-10-07T08:00:00Z");
/** 15:00: open, eight hours to go. */
const OPEN = at("2026-10-07T14:00:00Z");
/** 22:14: 46 minutes to go, still open. */
const MINUTES_46 = at("2026-10-07T21:14:00Z");
/** 22:15: 45 minutes to go, closing soon. */
const MINUTES_45 = at("2026-10-07T21:15:00Z");

const withHours = (openingHours: string | undefined): Place => ({ ...jacafe, openingHours });

/** The word's colour, by the state's kind; each a token, in both themes. */
const COLOUR = { closed: "text-accent", open: "text-open-now", soon: "text-closing-soon" } as const;
const OTHERS = Object.values(COLOUR);

/** The state word as a card or a row draws it: its own element, bold, in its colour. */
function stateWord(text: string, container: HTMLElement = document.body): HTMLElement {
  return within(container).getByText(text, { selector: "span" });
}

function expectColour(word: HTMLElement, colour: (typeof OTHERS)[number]): void {
  expect(word).toHaveClass("font-bold", colour);
  for (const other of OTHERS.filter((each) => each !== colour)) expect(word).not.toHaveClass(other);
  expect(word).not.toHaveClass("text-ink");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
});

describe("the hours on a card, a row and a chain's location row", () => {
  const draw = {
    card: (place: Place, now: Date) => <PlaceCard place={place} km={0.4} variant="normal" locale="en-US" now={now} />,
    "card docked on the map": (place: Place, now: Date) => (
      <PlaceCard place={place} km={0.4} variant="normal" locale="en-US" now={now} onMap />
    ),
    row: (place: Place, now: Date) => <PlaceRow place={place} km={0.4} locale="en-US" now={now} />,
    "row of the place page's Nearby": (place: Place, now: Date) => <PlaceRow place={place} km={0.4} from="place" locale="en-US" now={now} />,
    "chain's location row": (place: Place, now: Date) => <LocationRow place={place} km={0.4} locale="en-US" now={now} />,
  };
  const show = (element: JSX.Element) => render(<MemoryRouter>{element}</MemoryRouter>);

  describe.each(Object.entries(draw))("on a %s", (_, drawn) => {
    it("is red for Closed, and the rest of the line is as it was", () => {
      show(drawn(withHours(ELEVEN), CLOSED));
      const word = stateWord("Closed");
      expectColour(word, COLOUR.closed);
      expect(word.parentElement).toHaveTextContent("Closed · opens 11 am");
      expect(word.parentElement).toHaveClass("text-muted");
    });

    it("is green for Open, with 46 minutes to go", () => {
      show(drawn(withHours(ELEVEN), MINUTES_46));
      expectColour(stateWord("Open"), COLOUR.open);
      expect(stateWord("Open").parentElement).toHaveTextContent("Open until 11 pm");
    });

    it("is amber for Closing soon, with 45 minutes to go", () => {
      show(drawn(withHours(ELEVEN), MINUTES_45));
      expectColour(stateWord("Closing soon"), COLOUR.soon);
      expect(stateWord("Closing soon").parentElement).toHaveTextContent("Closing soon · 11 pm");
      expect(screen.queryByText("Open", { selector: "span" })).not.toBeInTheDocument();
    });

    it("is green for a place open all day, which never closes soon", () => {
      show(drawn(withHours("24/7"), MINUTES_45));
      expectColour(stateWord("Open"), COLOUR.open);
      expect(stateWord("Open").parentElement).toHaveTextContent(copy.hours.open24);
    });

    it("colours nothing when there are no hours, or hours as written", () => {
      for (const hours of [undefined, "by appointment"]) {
        const { unmount } = show(drawn(withHours(hours), OPEN));
        for (const colour of OTHERS) expect(document.querySelector(`.${colour}`)).toBeNull();
        unmount();
      }
    });
  });
});

describe("the hours on a place's page", () => {
  const jacafeEvent = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === JACAFE_D))!;
  const withEventHours = (hours: string): NostrEvent[] => [
    ...fixtures.filter((event) => event !== jacafeEvent),
    { ...jacafeEvent, tags: [...jacafeEvent.tags.filter((tag) => tag[0] !== "opening-hours"), ["opening-hours", hours]] },
  ];
  const openPlace = async (now: Date, px: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    return openApp(`/place/${JACAFE_D}`, { events: withEventHours(ELEVEN), px });
  };
  const header = () => screen.getByRole("heading", { level: 1, name: jacafe.name }).parentElement!;

  it.each([
    ["phone", PHONE, " · 11 pm"],
    ["desktop", DESKTOP, ", 11 pm"],
  ])("says 'Closing soon' in amber on a %s when it closes within 45 minutes, and leaves the time grey", async (_, px, rest) => {
    await openPlace(MINUTES_45, px);
    const lead = stateWord("Closing soon", header());
    expectColour(lead, COLOUR.soon);
    const after = lead.nextElementSibling!;
    expect(after.textContent).toBe(rest);
    expect(after).toHaveClass("text-muted");
  });

  it.each([
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ])("colours 'Open now' green and 'Closed' red on a %s", async (_, px) => {
    const open = await openPlace(OPEN, px);
    expectColour(stateWord("Open now", header()), COLOUR.open);
    open.unmount();
    vi.useRealTimers();
    await openPlace(CLOSED, px);
    expectColour(stateWord("Closed", header()), COLOUR.closed);
  });

  it("colours each place's word in the Nearby list by its own state, and leaves the week's table alone", async () => {
    await openPlace(MINUTES_45, PHONE);
    const nearby = screen.getByRole("heading", { level: 2, name: copy.place.nearby }).parentElement!;
    const places = parsePlaces(fixtures);
    let coloured = 0;
    for (const link of within(nearby).getAllByRole("link")) {
      const place = places.find((each) => `/place/${encodeURIComponent(each.d)}` === link.getAttribute("href"))!;
      const state = openState(place, MINUTES_45);
      if (state.kind !== "open" && state.kind !== "closed") continue;
      const soon = state.kind === "open" && state.closingSoon === true;
      const word = within(link).getByText(soon ? "Closing soon" : state.kind === "open" ? "Open" : "Closed", { selector: "span" });
      expectColour(word, state.kind === "closed" ? COLOUR.closed : soon ? COLOUR.soon : COLOUR.open);
      coloured += 1;
    }
    expect(coloured).toBeGreaterThan(0);
    // The week's table has no colour of these.
    const table = screen.getByRole("table");
    for (const colour of OTHERS) expect(table.querySelector(`.${colour}`)).toBeNull();
  });
});
