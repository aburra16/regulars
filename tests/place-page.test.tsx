import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { HereContext, type HereValue } from "../src/location/useLocation";
import { PIN_SOURCE } from "../src/map/pins";
import { actionsOf } from "../src/place/Actions";
import { addressOf } from "../src/place/Facts";
import { goUrl, osmNoteUrl, osmUrl } from "../src/place/osmLinks";
import { distanceKm, formatDistance } from "../src/places/distance";
import { weekTable } from "../src/places/hours";
import { buildIndexes } from "../src/places/indexes";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { writeSaved } from "../src/places/cache";
import { PlacesProvider, usePlaces } from "../src/places/store";
import { routes } from "../src/routes";
import raw from "./fixtures/funchal-items.json";
import { FakeMap, FakeMarker } from "./support/fakeMaplibre";
import { unbrokenPostcodes } from "../src/ui/address";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);
const idx = buildIndexes(fixturePlaces);
const HERE = config.defaultCity;
const PHONE = 390;
const DESKTOP = 1360;
const US = "en-US";

/** Wednesday 7 October 2026, 15:00 on the clock of Funchal (UTC+1 in October). */
const AFTERNOON = new Date("2026-10-07T14:00:00Z");

const byD = (d: string): Place => {
  const found = idx.byD.get(d);
  if (found === undefined) throw new Error(`No fixture place has d ${d}`);
  return found;
};

/** Every detail: an address, parsed hours, a phone, a website, bitcoin, an OpenStreetMap id. */
const JACAFE = byD("osm-node-11330857543");
/** A phone and hours, no website. */
const LOFT = byD("osm-node-3884132779");
/** Hours only: no phone, no website. */
const MALTEZ = byD("osm-node-10295182582");
/** No phone, no website, no hours. */
const MADALENAS = byD("osm-node-4269544449");
/** A phone, no website, no hours. */
const RECANTO = byD("osm-node-11697915754");
const NAME_ONLY = byD("crafted-minimal");
const LONG_NAME = byD("crafted-long-name");
const JAPANESE = byD("crafted-japanese-name");

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added) and a fresh, fake id. */
function variant(base: NostrEvent, over: Record<string, string>): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), tags: [...replaced, ...added] };
}

const eventOf = (d: string) => fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === d))!;
const nameOnlyEvent = eventOf("crafted-minimal");

/** The name-only place at `d`, with the tags in `over`, among the fixtures. */
function withPlace(over: Record<string, string>, d = "edge-case"): { events: NostrEvent[]; path: string } {
  return { events: [...fixtures, variant(nameOnlyEvent, { d, ...over })], path: `/place/${d}` };
}

// ---- The browser window, as wide as a phone or a desktop ----

let width = PHONE;
function setWidth(px: number) {
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

// ---- The app ----

/** The app at the last of `entries`, with the places read from `events`; resolves once the page has its places. */
async function openPlace(
  path: string,
  {
    px = PHONE,
    events = fixtures,
    entries,
    here,
  }: { px?: number; events?: NostrEvent[]; entries?: string[]; here?: HereValue } = {},
) {
  setWidth(px);
  const initialEntries = entries ?? [path];
  const router = createMemoryRouter(routes, { initialEntries, initialIndex: initialEntries.length - 1 });
  const page = <RouterProvider router={router} />;
  const view = render(
    <PlacesProvider reader={createMemoryReader(events)}>
      {/* `here`: where the person is, given; otherwise where the app works it out, which starts at the default city. */}
      {here === undefined ? <HereProvider>{page}</HereProvider> : <HereContext value={here}>{page}</HereContext>}
    </PlacesProvider>,
  );
  await waitFor(() => expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument());
  return { router, ...view };
}

/** Where the person is, as the app knows it: near a point, from the default city, a town they picked, or their device. */
function hereAt(lat: number, lon: number, source: HereValue["source"]): HereValue {
  return { label: source === "device" ? copy.location.you : "Funchal", lat, lon, source, pending: false, useDevice() {}, pickCity() {} };
}

const heading = () => screen.getByRole("heading", { level: 1 });
const link = (name: string | RegExp) => screen.getByRole("link", { name });
const queryLink = (name: string | RegExp) => screen.queryByRole("link", { name });
/** The facts, as a list of terms and what each says. */
const facts = () => screen.getByText(copy.place.facts.hours, { selector: "dt" }).closest("dl")!;
const factRows = () =>
  [...facts().querySelectorAll("dt")].map((term): [string, string] => [
    term.textContent ?? "",
    term.nextElementSibling?.textContent ?? "",
  ]);
const factValue = (label: string) => within(facts()).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
/** The words of a link that opens a new tab, with what it says only to a screen reader. */
const newTab = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${copy.common.newTab.replace(/[()]/g, "\\$&")}$`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTERNOON);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
  config.features.signIn = false;
});

// ---- The header ----

describe("the place page: header", () => {
  it("shows the kind tile, the name, what it is, and whether it is open, in place form", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const header = heading().closest("section")!;

    expect(header.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(heading()).toHaveTextContent(JACAFE.name);

    const kind = placeKindLabel(JACAFE.category, JACAFE.cuisine);
    // The device has not said where the person is: how far the place is from the default city is not how far it is from them.
    expect(within(header).getByText(kind)).toBeInTheDocument();
    expect(header).not.toHaveTextContent(/away/);
    expect(copy.place.kindAway(kind, "")).toBe(kind);
    // 15:00 on a Wednesday; the hours are Mo-Fr 09:30-17:30.
    expect(header).toHaveTextContent("Open now · closes 5:30 pm");
    expect(within(header).getByText("Open now")).toHaveClass("font-bold");
  });

  it.each([
    ["the default city", "default" as const],
    ["a town the person picked", "city" as const],
  ])("says nothing of how far when the places are near %s, on a phone and a desktop", async (_, source) => {
    const here = hereAt(32.66, -16.92, source);
    for (const px of [PHONE, DESKTOP]) {
      const { unmount } = await openPlace(`/place/${JACAFE.d}`, { px, here });
      const kind = placeKindLabel(JACAFE.category, JACAFE.cuisine);
      expect(heading().parentElement!.parentElement).toHaveTextContent(kind);
      expect(screen.queryByText(/ away/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("says how far away the place is when the device has said where the person is, on a phone and a desktop", async () => {
    const here = hereAt(32.66, -16.92, "device");
    const away = formatDistance(distanceKm(32.66, -16.92, JACAFE.lat, JACAFE.lon), US);
    const kind = placeKindLabel(JACAFE.category, JACAFE.cuisine);
    expect(copy.place.kindAway(kind, away)).toBe(`${kind} · ${away} away`);

    await openPlace(`/place/${JACAFE.d}`, { here });
    expect(within(heading().closest("section")!).getByText(`${kind} · ${away} away`)).toBeInTheDocument();
    cleanup();

    await openPlace(`/place/${JACAFE.d}`, { px: DESKTOP, here });
    expect(within(heading().closest("section")!).getByText(`${kind} · ${away} away`, { exact: false })).toBeInTheDocument();
  });

  it("says the hours are not listed, in grey, when there are none", async () => {
    await openPlace(`/place/${MADALENAS.d}`);
    const header = heading().closest("section")!;
    expect(within(header).getByText(copy.hours.notListed)).toHaveClass("text-muted");
  });

  it("shows hours it cannot read on one line, cut off, with the whole of them in the facts", async () => {
    const hours = "Mo-Fr 09:00-17:00 por marcação, sábados só no verão, feriados fechado";
    const { events, path } = withPlace({ "opening-hours": hours });
    await openPlace(path, { events });
    const header = heading().closest("section")!;
    expect(within(header).getByText(hours)).toHaveClass("truncate");
    expect(within(header).getByText(hours)).toHaveAttribute("title", hours);
  });

  it("names the page after the place", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    await waitFor(() => expect(document.title).toBe(`${JACAFE.name} · ${config.appName}`));
    expect(copy.titles.place(JACAFE.name)).toBe(document.title);
  });

  it("goes back the way the person came, with the back arrow", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = await openPlace(`/place/${JACAFE.d}`, { entries: ["/search?q=cafe", `/place/${JACAFE.d}`] });
    await user.click(link(copy.place.back));
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toBe("?q=cafe");
    expect(router.state.historyAction).toBe("POP");
  });

  it("goes to Explore when the place was the first page opened", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = await openPlace(`/place/${JACAFE.d}`);
    const back = link(copy.place.backHome);
    expect(back).toHaveAttribute("href", "/");
    await user.click(back);
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("PUSH");
  });

  it("asks the person to sign in to save the place", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = await openPlace(`/place/${JACAFE.d}`);
    const save = link(copy.place.save);
    expect(save).toHaveAttribute("href", "/signin");
    await user.click(save);
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: `/place/${JACAFE.d}` } });
  });
});

// ---- The score panel ----

describe("the place page: the score panel, before anyone has reviewed it", () => {
  it("asks the person to be the first, by the place's name, with the design's words", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const panel = screen.getByText("Be the first in your circle").closest("section")!;
    expect(panel).toHaveClass("border-dashed");
    expect(panel).toHaveTextContent(
      `Nobody has reviewed ${JACAFE.name} yet. Yours is the one the people who trust you will see.`,
    );
    expect(within(panel).getByRole("link", { name: "Rate this place" })).toBeInTheDocument();
  });

  it("goes to sign in from Rate this place while sign in is off, and can come back", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    expect(config.features.signIn).toBe(false);
    const { router } = await openPlace(`/place/${JACAFE.d}`);
    const rate = link("Rate this place");
    expect(rate).toHaveAttribute("href", "/signin");
    await user.click(rate);
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.state).toMatchObject({ from: { pathname: `/place/${JACAFE.d}` } });
  });

  it("marks the name in the sentence with its script, and keeps its direction to itself", async () => {
    await openPlace(`/place/${JAPANESE.d}`);
    const panel = screen.getByText("Be the first in your circle").closest("section")!;
    const name = within(panel).getByText(JAPANESE.name);
    expect(name.tagName).toBe("BDI");
    expect(name).toHaveAttribute("lang", "ja");
  });
});

// ---- The actions ----

describe("the place page: actions", () => {
  it("has Go, Call and Site for a place with a phone and a website", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const go = link(newTab(copy.place.go));
    expect(go).toHaveAttribute("href", goUrl(JACAFE));
    expect(go).toHaveAttribute("target", "_blank");
    expect(go).toHaveAttribute("rel", "noopener noreferrer");

    const call = link(copy.place.call);
    expect(call).toHaveAttribute("href", "tel:+351926958673");
    expect(call).not.toHaveAttribute("target");

    const site = screen.getByRole("link", { name: new RegExp(`^${copy.place.site}`) });
    expect(site).toHaveAttribute("href", "https://www.jacahostel.com");
    expect(site).toHaveAttribute("target", "_blank");
    expect(site).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(site).toHaveAccessibleName(`${copy.place.site} www.jacahostel.com ${copy.common.newTab}`);

    // Three side by side (Place.dc.html).
    expect(go.parentElement).toHaveClass("grid", "grid-cols-3");
  });

  it("leaves out Site for a place with no website", async () => {
    await openPlace(`/place/${LOFT.d}`);
    expect(link(newTab(copy.place.go))).toBeInTheDocument();
    expect(link(copy.place.call)).toHaveAttribute("href", "tel:+351291640513");
    expect(queryLink(new RegExp(`^${copy.place.site}`))).not.toBeInTheDocument();
    expect(link(copy.place.call).parentElement).toHaveClass("grid", "grid-cols-2");
  });

  it("has only Get directions, the width of the page, for a place with neither", async () => {
    await openPlace(`/place/${MALTEZ.d}`);
    const go = link(newTab(copy.place.directions));
    expect(copy.place.directions).toBe("Get directions");
    expect(go).toHaveAttribute("href", goUrl(MALTEZ));
    expect(go).toHaveClass("h-13", "w-full");
    expect(queryLink(copy.place.call)).not.toBeInTheDocument();
    expect(queryLink(new RegExp(`^${copy.place.site}`))).not.toBeInTheDocument();
  });

  describe("actionsOf", () => {
    const of = (over: Partial<Place>) => actionsOf({ ...NAME_ONLY, ...over });

    it("always has Go, to directions in the person's map app", () => {
      expect(of({}).go).toBe(goUrl(NAME_ONLY));
      expect(of({}).call).toBeUndefined();
      expect(of({}).site).toBeUndefined();
    });

    it("calls the number with its spaces taken out, the first of several", () => {
      expect(of({ phone: "+351 291 640 513" }).call).toBe("tel:+351291640513");
      expect(of({ phone: "+351 291 640 513;+351 912 000 000" }).call).toBe("tel:+351291640513");
      expect(of({ phone: "+351 291 640 513 / +351 912 000 000" }).call).toBe("tel:+351291640513");
      expect(of({ phone: "+351 291 640 513, +351 912 000 000" }).call).toBe("tel:+351291640513");
      expect(of({ phone: " +1 (615) 555-0142 " }).call).toBe("tel:+16155550142");
      expect(of({ phone: "ask at the bar" }).call).toBeUndefined();
      expect(of({ phone: "javascript:alert(1)" }).call).toBeUndefined();
    });

    it("reads the numbers people write: a + in brackets, an extension, full-width digits, direction marks", () => {
      expect(of({ phone: "(+258) 87 022 7777" }).call).toBe("tel:+258870227777");
      expect(of({ phone: "+350 200 43461 x203" }).call).toBe("tel:+35020043461");
      expect(of({ phone: "+44 20 7946 0958 ext. 12" }).call).toBe("tel:+442079460958");
      expect(of({ phone: "＋81 76 255 1122" }).call).toBe("tel:+81762551122");
      expect(of({ phone: "+351 291 640 513\u202C" }).call).toBe("tel:+351291640513");
      expect(of({ phone: "\u202A+351 291 640 513\u202C" }).call).toBe("tel:+351291640513");
      expect(of({ phone: "\u200E+971 4 123 4567\u200F" }).call).toBe("tel:+97141234567");
      // A slash inside one number, as some countries write the area code, is not two numbers.
      expect(of({ phone: "0761 / 12345" }).call).toBe("tel:076112345");
      // A + anywhere else is not a number.
      expect(of({ phone: "291 + 640 513" }).call).toBeUndefined();
    });

    it("shows the number as it was written, whatever the link dials", async () => {
      const written = "(+258) 87 022 7777";
      const { events, path } = withPlace({ phone: written });
      await openPlace(path, { events });
      const phone = within(factValue(copy.place.facts.phone)).getByRole("link");
      expect(phone).toHaveTextContent(written);
      expect(phone).toHaveAttribute("href", "tel:+258870227777");
      expect(link(copy.place.call)).toHaveAttribute("href", "tel:+258870227777");
    });

    it("links a website only over http or https, with its host to name it", () => {
      expect(of({ website: "https://motya.pt" }).site).toEqual({ href: "https://motya.pt", host: "motya.pt" });
      expect(of({ website: "http://example.com/menu?a=1" }).site).toEqual({ href: "http://example.com/menu?a=1", host: "example.com" });
      expect(of({ website: "HTTPS://Example.com" }).site?.host).toBe("example.com");
      expect(of({ website: "www.example.com" }).site).toEqual({ href: "https://www.example.com", host: "www.example.com" });
      expect(of({ website: "javascript:alert(1)" }).site).toBeUndefined();
      expect(of({ website: "ftp://example.com" }).site).toBeUndefined();
      expect(of({ website: "https://" }).site).toBeUndefined();
    });

    it("takes a bare host name as a website over https, and nothing that is not one", () => {
      expect(of({ website: "www.catchtwentyseven.com" }).site).toEqual({
        href: "https://www.catchtwentyseven.com",
        host: "www.catchtwentyseven.com",
      });
      expect(of({ website: "jhcoffee.co.za" }).site).toEqual({ href: "https://jhcoffee.co.za", host: "jhcoffee.co.za" });
      expect(of({ website: "instagram.com/lamenaga" }).site).toEqual({
        href: "https://instagram.com/lamenaga",
        host: "instagram.com",
      });
      for (const website of ["@lamenaga", "a@b.com", "lamenaga", "mailto:a@b.com", "javascript:alert(1.2)", "two words.com", "/menu.html", ".com"]) {
        expect(of({ website }).site, website).toBeUndefined();
      }
    });

    it("cuts a long host short", () => {
      const host = `${"a".repeat(120)}.example.com`;
      const site = of({ website: `https://${host}/x` }).site!;
      expect(site.href).toBe(`https://${host}/x`);
      expect([...site.host].length).toBeLessThanOrEqual(41);
      expect(site.host.endsWith("…")).toBe(true);
    });
  });
});

// ---- The facts ----

describe("the place page: facts", () => {
  it("lists the address, the week's hours, the phone and the payment row with the chip", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    expect(factRows().map(([term]) => term)).toEqual([
      copy.place.facts.address,
      copy.place.facts.hours,
      copy.place.facts.phone,
      copy.place.facts.payment,
    ]);
    // The postcode's hyphen is one the line does not break at (U+2011): "9000-|082" never splits.
    expect(factValue(copy.place.facts.address)).toHaveTextContent("138 Rua dos Ferreiros Funchal 9000\u2011082");

    const table = within(factValue(copy.place.facts.hours)).getByRole("table");
    const rows = within(table).getAllByRole("row").map((row) => row.textContent);
    const week = weekTable(JACAFE, AFTERNOON, US)!;
    expect(rows).toEqual(week.map(({ day, ranges }) => `${day}${ranges.join(", ")}`));
    expect(rows[0]).toBe("Mon9:30 am to 5:30 pm");
    expect(rows[6]).toBe("Sun9:30 am to 1:30 pm");
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([...copy.hours.weekdaysShort]);

    const phone = within(factValue(copy.place.facts.phone)).getByRole("link");
    expect(phone).toHaveTextContent("+351 926 958 673");
    expect(phone).toHaveAttribute("href", "tel:+351926958673");

    expect(factValue(copy.place.facts.payment)).toHaveTextContent("Bitcoin accepted");
    expect(copy.place.bitcoinChip).toBe("Bitcoin accepted");
  });

  it("does not call a day closed when the night before ran into its afternoon", async () => {
    const { events, path } = withPlace({ "opening-hours": "Fr 21:00-24:00; Sa 00:00-17:00" });
    await openPlace(path, { events });
    const rows = within(factValue(copy.place.facts.hours)).getAllByRole("row");
    expect(rows[4]).toHaveTextContent(`Fri9 pm to ${copy.hours.midnight}`);
    expect(rows[5]).toHaveTextContent("Sat12 am to 5 pm");
  });

  it("says Closed for a day the place does not open", async () => {
    await openPlace(`/place/${byD("osm-node-12971275599").d}`); // Tu-Sa 09:00-18:00
    const rows = within(factValue(copy.place.facts.hours)).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(`Mon${copy.hours.closed}`);
    expect(rows[6]).toHaveTextContent(`Sun${copy.hours.closed}`);
  });

  it("shows hours it cannot read as written, wrapped", async () => {
    const hours = `Mo-Fr 09:00-17:00 ${"por marcação ".repeat(12)}`.trim();
    const { events, path } = withPlace({ "opening-hours": hours });
    await openPlace(path, { events });
    const value = factValue(copy.place.facts.hours);
    const text = within(value).getByText(hours);
    expect(text.tagName).toBe("P");
    expect(text).toHaveClass("wrap-break-word");
    expect(within(value).queryByRole("table")).not.toBeInTheDocument();
  });

  it("says the hours are not listed, in grey, when there are none", async () => {
    await openPlace(`/place/${MADALENAS.d}`);
    expect(factValue(copy.place.facts.hours)).toHaveTextContent(copy.place.hoursNotListed);
    expect(factValue(copy.place.facts.hours)).toHaveClass("text-muted");
    expect(copy.place.hoursNotListed).toBe("Not listed");
  });

  it("adds the town and the postcode to a street address that lacks them, and only then", async () => {
    const { events, path } = withPlace({ address: "12 Rua Nova", locality: "Funchal", "postal-code": "9000-001" });
    await openPlace(path, { events });
    expect(factValue(copy.place.facts.address)).toHaveTextContent(/^12 Rua Nova Funchal 9000\u2011001$/);
  });

  it("keeps a postcode whole: a hyphen between digits does not break, and other hyphens do", () => {
    expect(unbrokenPostcodes("Funchal 9000-082")).toBe("Funchal 9000\u2011082");
    expect(unbrokenPostcodes("1-2-3")).toBe("1\u20112\u20113");
    expect(unbrokenPostcodes("Rua Dr. Fernão de Ornelas 56-A, Funchal")).toBe("Rua Dr. Fernão de Ornelas 56-A, Funchal");
    expect(unbrokenPostcodes("Santa-Cruz 9100 - 024")).toBe("Santa-Cruz 9100 - 024");
    expect(addressOf({ street: "1 Rua Nova", locality: "Funchal", postalCode: "9000-001" })).toBe("1 Rua Nova Funchal 9000\u2011001");
  });

  it("gives the town alone as the address when there is no street", async () => {
    const { events, path } = withPlace({ locality: "Funchal" });
    await openPlace(path, { events });
    expect(factValue(copy.place.facts.address)).toHaveTextContent(/^Funchal$/);
  });

  it("shows the chip only for a place that takes bitcoin, and the word nowhere else", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const chips = screen.getAllByText(copy.place.bitcoinChip);
    expect(chips).toHaveLength(1);
    expect(document.body.textContent?.match(/bitcoin/gi)).toHaveLength(1);
  });

  it("has no payment row for a place that does not say it takes bitcoin", async () => {
    await openPlace(`/place/${NAME_ONLY.d}`);
    expect(within(facts()).queryByText(copy.place.facts.payment)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/bitcoin/i);
  });

  it("shows a phone number as written", async () => {
    const { events, path } = withPlace({ phone: "+351 291 640 513 / +351 912 000 000" });
    await openPlace(path, { events });
    const phone = within(factValue(copy.place.facts.phone)).getByRole("link");
    expect(phone).toHaveTextContent("+351 291 640 513 / +351 912 000 000");
    // The first of the numbers is the one to call.
    expect(phone).toHaveAttribute("href", "tel:+351291640513");
  });

  it("shows text that is not a phone number as text, with no Call", async () => {
    const { events, path } = withPlace({ phone: "ask at the bar" });
    await openPlace(path, { events });
    expect(factValue(copy.place.facts.phone)).toHaveTextContent("ask at the bar");
    expect(within(factValue(copy.place.facts.phone)).queryByRole("link")).not.toBeInTheDocument();
    expect(queryLink(copy.place.call)).not.toBeInTheDocument();
  });
});

// ---- The missing details ----

describe("the place page: missing details", () => {
  const line = () => screen.getByText(/listed\. Know (it|them)\?/).closest("p")!;

  it("asks for the phone, website and hours a place lacks, linking to a note on the map", async () => {
    await openPlace(`/place/${MADALENAS.d}`);
    expect(line()).toHaveTextContent("No phone, website or hours listed. Know them? Suggest a fix");
    const fix = within(line()).getByRole("link", { name: newTab(copy.place.suggestFix) });
    expect(fix).toHaveAttribute("href", osmNoteUrl(MADALENAS.lat, MADALENAS.lon));
    expect(fix).toHaveAttribute("target", "_blank");
    expect(fix).toHaveAttribute("rel", "noopener noreferrer");
    expect(line()).toHaveClass("text-caption", "text-muted");
  });

  it("names only what is missing", async () => {
    expect(copy.place.missingDetails(false, true, false)).toBe("No website listed. Know it?");
    expect(copy.place.missingDetails(true, true, false)).toBe("No phone or website listed. Know them?");
    expect(copy.place.missingDetails(false, false, true)).toBe("No hours listed. Know them?");
    expect(copy.place.missingDetails(true, false, true)).toBe("No phone or hours listed. Know them?");
    await openPlace(`/place/${RECANTO.d}`);
    expect(line()).toHaveTextContent(/^No website or hours listed\. Know them\? Suggest a fix/);
  });

  it("is not there when nothing is missing", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    expect(screen.queryByText(/listed\. Know (it|them)\?/)).not.toBeInTheDocument();
  });
});

// ---- The map, and a picture ----

describe("the place page: map", () => {
  it("is a picture of where the place is: not moved by the person, at the place, close in, its pin chosen", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    expect(map.options).toMatchObject({ interactive: false, center: [JACAFE.lon, JACAFE.lat], zoom: 16 });
    // Its one pin is the chosen one, drawn on its own: the source the map gathers into bubbles is without it.
    expect(map.sources.get(PIN_SOURCE)!.data.features).toEqual([]);
    // The pin is the design's drop (Place.dc.html): 34 px, in the accent colour with a white dot, its tip on the place.
    const drop = await waitFor(() => {
      const found = [...map.container.querySelectorAll("svg")].find((svg) => svg.classList.contains("size-[34px]"));
      if (found === undefined) throw new Error("No drop yet");
      return found;
    });
    expect(drop).toHaveClass("wide:size-[38px]");
    expect(drop).toHaveAttribute("viewBox", "0 0 24 24");
    expect(drop.querySelector("path")).toHaveAttribute("d", "M12 22s7-6.4 7-12A7 7 0 0 0 5 10c0 5.6 7 12 7 12z");
    expect(drop.querySelector("path")).toHaveClass("fill-accent");
    expect(drop.querySelector("circle")).toHaveAttribute("r", "2.6");
    expect(drop.querySelector("circle")).toHaveClass("fill-on-accent");
    const marker = FakeMarker.instances.find((each) => each.element.contains(drop))!;
    expect(marker.anchor).toBe("bottom");
    expect(map.container.querySelector(".border-accent")).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(JACAFE.name) })).not.toBeInTheDocument();
    // The map says whose it is.
    const attribution = screen.getByText((_, element) => element?.tagName === "P" && element.textContent === copy.attribution.map);
    expect(attribution).toBeVisible();
  });

  it("is one picture to a screen reader, named for the place, with its attribution still reachable", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const picture = screen.getByRole("img", { name: copy.place.mapLabel(JACAFE.name) });
    expect(copy.place.mapLabel(JACAFE.name)).toContain(JACAFE.name);
    const canvas = await waitFor(() => {
      const found = picture.querySelector("canvas");
      if (found === null) throw new Error("No canvas yet");
      return found;
    });
    expect(canvas.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole("region", { name: copy.map.label })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.attribution.mapTiler })).toBeInTheDocument();
    expect(picture).not.toContainElement(screen.getByRole("link", { name: copy.attribution.mapTiler }));
  });

  it("shows no photograph, and loads nothing from the place's picture address, on a phone or a desktop", async () => {
    // No photographs anywhere (the brief, section 10), and no network call but the relay's and the map's.
    const images = ["https://images.example.com/front.jpg", "http://images.example.com/front.jpg", "//cdn.example.com/a.png"];
    for (const px of [PHONE, DESKTOP]) {
      for (const [i, image] of images.entries()) {
        const { events, path } = withPlace({ image }, `image-${px}-${i}`);
        const { container, unmount } = await openPlace(path, { events, px });
        const remote = [...container.querySelectorAll("img")].filter((img) => /^(?:[a-z]+:)?\/\//i.test(img.getAttribute("src") ?? ""));
        expect(remote).toEqual([]);
        expect(container.innerHTML).not.toContain("images.example.com");
        expect(container.innerHTML).not.toContain("cdn.example.com");
        unmount();
      }
    }
  });
});

// ---- Nearby ----

describe("the place page: nearby", () => {
  it("lists the three closest other places, as rows, by how far they are from this one", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const section = screen.getByRole("heading", { level: 2, name: "Nearby" }).closest("section")!;
    expect(copy.place.nearby).toBe("Nearby");
    const expected = idx
      .near(JACAFE.lat, JACAFE.lon, HERE.radiusKm, 4)
      .filter(({ place }) => place.address !== JACAFE.address)
      .slice(0, 3);
    const rows = within(section).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(
      expected.map(({ place }) => `/place/${encodeURIComponent(place.d)}`),
    );
    expect(rows[0]).toHaveTextContent(`${formatDistance(expected[0]!.km, US)} from here`);
    expect(copy.place.fromHere("0.3 mi")).toBe("0.3 mi from here");
  });
});

// ---- The footer ----

describe("the place page: footer", () => {
  it("has Suggest a fix, the place on OpenStreetMap, and where the details come from", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const footer = document.querySelector("footer")!;
    const fix = within(footer).getByRole("link", { name: newTab("Something wrong? Suggest a fix") });
    expect(copy.place.somethingWrong).toBe("Something wrong? Suggest a fix");
    expect(fix).toHaveAttribute("href", osmNoteUrl(JACAFE.lat, JACAFE.lon));
    expect(fix).toHaveAttribute("rel", "noopener noreferrer");

    const osm = within(footer).getByRole("link", { name: newTab(copy.place.viewOnOsm) });
    expect(osm).toHaveAttribute("href", osmUrl(JACAFE.osmId!));
    expect(osm).toHaveAttribute("rel", "noopener noreferrer");

    expect(footer).toHaveTextContent(copy.attribution.details);
    expect(within(footer).getByRole("link", { name: copy.common.aboutData })).toHaveAttribute("href", "/about");
    expect(document.body).not.toHaveTextContent(/Also listed by/);
  });

  it("gives About this data a target 24 px tall or more, from padding that does not move the words", async () => {
    await openPlace(`/place/${JACAFE.d}`);
    const about = within(document.querySelector("footer")!).getByRole("link", { name: copy.common.aboutData });
    // 6 px above and below the 16 px line, taken back by as much margin: the line sits where it did.
    expect(about).toHaveClass("py-1.5", "-my-1.5");
  });

  it("leaves out the OpenStreetMap link for a place with no OpenStreetMap id", async () => {
    await openPlace(`/place/${NAME_ONLY.d}`);
    expect(queryLink(newTab(copy.place.viewOnOsm))).not.toBeInTheDocument();
  });

  it("sends every link out of the app to a new tab, telling nothing of where it came from", async () => {
    const { container } = await openPlace(`/place/${JACAFE.d}`);
    const outbound = [...container.querySelectorAll<HTMLAnchorElement>("a[href^='http']")];
    expect(outbound.length).toBeGreaterThanOrEqual(6);
    for (const anchor of outbound) {
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
  });
});

describe("the place page: one helper says a link opens a new tab", () => {
  it("is the only place in the app that reads the words", () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    })(resolve(process.cwd(), "src"));
    const readers = files
      .filter((file) => /\.tsx?$/.test(file) && readFileSync(file, "utf8").includes("copy.common.newTab"))
      .map((file) => relative(process.cwd(), file));
    expect(readers).toEqual([join("src", "ui", "NewTab.tsx")]);
  });
});

// ---- A place that is not there ----

describe("the place page: a place that is not listed", () => {
  it("says it came off the map, with a way back to Explore", async () => {
    await openPlace("/place/osm-node-0");
    expect(copy.place.noLongerListed).toBe("No longer listed.");
    expect(copy.place.noLongerListedDetail).toBe("It came off the map at the last monthly refresh.");
    expect(heading()).toHaveTextContent(copy.place.noLongerListed);
    expect(screen.getByText(copy.place.noLongerListedDetail)).toBeInTheDocument();
    expect(link(copy.place.backToExplore)).toHaveAttribute("href", "/");
    await waitFor(() => expect(document.title).toBe(copy.titles.notListed));
  });

  /** The app at `path`, with `saved` on the device and `latest` from the relay a moment later. */
  async function openWithSaved(path: string, saved: NostrEvent[], latest: NostrEvent[]) {
    await writeSaved({ events: saved, savedAt: Date.now(), complete: true });
    setWidth(PHONE);
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
      <PlacesProvider reader={createMemoryReader(latest, { delayMs: 200 })}>
        <Probe />
        <HereProvider>
          <RouterProvider router={router} />
        </HereProvider>
      </PlacesProvider>,
    );
    // The saved places are on screen, and the relay has not answered yet.
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(`${parsePlaces(saved).length} cache`));
  }

  /** What the store holds: how many places, and where from. */
  function Probe() {
    const { places, source } = usePlaces();
    return <span data-testid="probe">{`${places.length} ${source}`}</span>;
  }

  it("waits for the latest list before it says so: a place new to it is not off the map", async () => {
    const added = variant(nameOnlyEvent, { d: "new-place", name: "Brand New Cafe" });
    await openWithSaved("/place/new-place", fixtures, [...fixtures, added]);
    expect(screen.queryByText(copy.place.noLongerListedDetail)).not.toBeInTheDocument();
    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Brand New Cafe" })).toBeInTheDocument();
  });

  it("says so once the latest list does not have it either", async () => {
    await openWithSaved("/place/osm-node-0", fixtures, fixtures);
    expect(screen.queryByText(copy.place.noLongerListedDetail)).not.toBeInTheDocument();
    expect(await screen.findByText(copy.place.noLongerListedDetail)).toBeInTheDocument();
  });

  it("goes back to the Explore it left, in one step", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setWidth(PHONE);
    window.history.replaceState(null, "", "/");
    const router = createBrowserRouter(routes);
    render(
      <PlacesProvider reader={createMemoryReader(fixtures)}>
        <HereProvider>
          <RouterProvider router={router} />
        </HereProvider>
      </PlacesProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: copy.pages.explore });
    await act(() => router.navigate("/place/osm-node-0"));
    await user.click(await screen.findByRole("link", { name: copy.place.backToExplore }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.historyAction).toBe("POP");
    router.dispose();
  });
});

// ---- The desktop ----

describe("the place page at 1360 px (D2)", () => {
  it("has the top bar, a way back, a content column and a 320 px rail", async () => {
    await openPlace(`/place/${JACAFE.d}`, { px: DESKTOP, entries: ["/", `/place/${JACAFE.d}`] });
    expect(screen.getByRole("search")).toBeInTheDocument();
    // In words, where the phone has only the arrow (DeskPlace.dc.html).
    expect(link(copy.place.back)).toHaveTextContent(copy.place.back);
    expect(copy.place.back).toBe("Back to results");

    const rail = screen.getByRole("complementary", { name: copy.place.railLabel });
    expect(rail).toHaveClass("w-rail", "shrink-0");
    const column = heading().closest("section")!.parentElement!;
    expect(column).toHaveClass("min-w-0", "flex-1");
    expect(column).not.toContainElement(rail);

    // The column: the name, the panel and the places nearby.
    expect(within(column).getByText("Be the first in your circle")).toBeInTheDocument();
    expect(within(column).getByRole("heading", { level: 2, name: copy.place.nearby })).toBeInTheDocument();
    expect(within(column).queryByRole("link", { name: "Rate this place" })).not.toBeInTheDocument();
    // Prose in the column is held to the measure of review text.
    expect(within(column).getByText(/Yours is the one/)).toHaveClass("max-w-measure");
    // The desktop's panel: 24 px corners and 22 px inside (DeskPlace.dc.html), from tokens.
    const panel = within(column).getByText("Be the first in your circle").closest("section")!;
    expect(panel).toHaveClass("rounded-panel-desktop", "p-panel-desktop");
    expect(panel.className).not.toMatch(/\[/);
  });

  it("puts Rate this place, Go, Call, Site and Save, the map, the facts with the chip, Suggest a fix and the attribution in the rail", async () => {
    await openPlace(`/place/${JACAFE.d}`, { px: DESKTOP });
    const rail = screen.getByRole("complementary");
    const inRail = within(rail);

    expect(inRail.getByRole("link", { name: "Rate this place" })).toHaveAttribute("href", "/signin");
    expect(inRail.getByRole("link", { name: newTab(copy.place.go) })).toHaveAttribute("href", goUrl(JACAFE));
    expect(inRail.getByRole("link", { name: copy.place.call })).toHaveAttribute("href", "tel:+351926958673");
    expect(inRail.getByRole("link", { name: new RegExp(`^${copy.place.site}`) })).toHaveAttribute("href", JACAFE.website!);
    expect(inRail.getByRole("link", { name: copy.place.saveShort })).toHaveAttribute("href", "/signin");
    await waitFor(() => expect(rail.querySelector("canvas")).not.toBeNull());
    expect(inRail.getByText(copy.place.facts.address)).toBeInTheDocument();
    expect(inRail.getByText(copy.place.bitcoinChip)).toBeInTheDocument();
    expect(inRail.getByRole("link", { name: newTab(copy.place.somethingWrong) })).toBeInTheDocument();
    expect(rail).toHaveTextContent(copy.attribution.details);
    expect(rail).toHaveTextContent(copy.attribution.map);

    // Once each on the page.
    expect(screen.getAllByText(copy.place.bitcoinChip)).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Rate this place" })).toHaveLength(1);
  });

  it("shows the kind, the distance and the hours on one line under the name", async () => {
    await openPlace(`/place/${JACAFE.d}`, { px: DESKTOP, here: hereAt(HERE.lat, HERE.lon, "device") });
    const header = heading().closest("section")!;
    const kind = placeKindLabel(JACAFE.category, JACAFE.cuisine);
    // DeskPlace.dc.html: "Seafood restaurant · 0.4 mi away · Open now, closes 10 pm".
    expect(header).toHaveTextContent(new RegExp(`${kind} · .+ away · Open now, closes 5:30 pm`));
    cleanup();
    // With no distance, the kind and the hours.
    await openPlace(`/place/${JACAFE.d}`, { px: DESKTOP });
    expect(heading().closest("section")!).toHaveTextContent(`${kind} · Open now, closes 5:30 pm`);
    expect(within(header).getByText("Open now")).toHaveClass("font-bold");
    expect(copy.hours.openNowClosesInline("10 pm")).toBe("Open now, closes 10 pm");
    expect(copy.hours.closedOpensInline("7 am")).toBe("Closed, opens 7 am");
  });
});

// ---- Sparse and edge places ----

describe("the place page: sparse and edge places (Review Focus 5)", () => {
  it("draws a place with only a name with no empty labelled rows", async () => {
    await openPlace(`/place/${NAME_ONLY.d}`);
    expect(factRows()).toEqual([[copy.place.facts.hours, copy.place.hoursNotListed]]);
    for (const [, value] of factRows()) expect(value.trim()).not.toBe("");
    // Go is all it can do; the rest it lacks is asked for.
    expect(link(newTab(copy.place.directions))).toBeInTheDocument();
    expect(screen.getByText(/No phone, website or hours listed/)).toBeInTheDocument();
    for (const each of screen.getAllByRole("heading")) expect(each.textContent?.trim()).not.toBe("");
  });

  it("wraps a 67-character name inside the width of a phone", async () => {
    expect(LONG_NAME.name).toHaveLength(67);
    await openPlace(`/place/${LONG_NAME.d}`);
    expect(heading()).toHaveTextContent(LONG_NAME.name);
    expect(heading()).toHaveClass("wrap-break-word", "min-w-0");
    expect(heading()).toHaveAttribute("dir", "auto");
    expect(heading()).not.toHaveAttribute("lang");
    expect(heading().closest("section")).toHaveClass("min-w-0");
    expect(screen.getByText(/Yours is the one/)).toHaveClass("wrap-break-word");
  });

  it("marks a Japanese name as Japanese, and wraps it inside the width of a phone", async () => {
    await openPlace(`/place/${JAPANESE.d}`);
    expect(heading()).toHaveTextContent(JAPANESE.name);
    expect(heading()).toHaveAttribute("lang", "ja");
    expect(heading()).toHaveAttribute("dir", "auto");
    expect(heading()).toHaveClass("wrap-break-word", "min-w-0");
  });

  it("wraps a long address, a long phone and long hours", async () => {
    const long = "Rua ".repeat(40);
    const { events, path } = withPlace({ address: long.trim(), phone: "+351".padEnd(80, "9") });
    await openPlace(path, { events });
    expect(factValue(copy.place.facts.address)).toHaveClass("wrap-break-word", "min-w-0");
    expect(factValue(copy.place.facts.phone)).toHaveClass("wrap-break-word", "min-w-0");
  });

  it("never draws the label of a fact it has nothing for", async () => {
    await openPlace(`/place/${MALTEZ.d}`);
    expect(factRows().map(([term]) => term)).toEqual([
      copy.place.facts.address,
      copy.place.facts.hours,
      copy.place.facts.payment,
    ]);
  });
});
