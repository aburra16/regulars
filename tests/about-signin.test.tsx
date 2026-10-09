import type { NostrEvent } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aboutFigures, formatRefreshed } from "../src/about/figures";
import { NOTICES_FILE } from "../src/about/notices";
import houseBadge96 from "../src/assets/house/house-96.png";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { parsePlaces } from "../src/places/load";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";

const fixtures: NostrEvent[] = raw;
const places = parsePlaces(fixtures);

/** The newest `created_at` of the fixtures: 5 October 2026, 23:25 UTC. */
const REFRESHED_AT = 1791242721;
const DAY = 86_400;

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added), a fresh, fake id and, if given, a time. */
function variant(base: NostrEvent, over: Record<string, string>, createdAt = base.created_at): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), created_at: createdAt, tags: [...replaced, ...added] };
}
const jacafe = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === "osm-node-11330857543"))!;

// ---- Reading the page ----

const heading = (level = 1) => screen.getByRole("heading", { level });
const link = (name: string | RegExp) => screen.getByRole("link", { name });
/** A section by the name of its heading. */
const section = (name: string) => screen.getByRole("region", { name });
/** The words of the house's section: its one paragraph. */
const houseBody = () => section(copy.about.houseHeading).querySelector("p")!;
/** What a figure of the data says: the row's value, by its label. */
const figure = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const banner = () => screen.queryByRole("banner");
const tabBar = () => screen.queryByRole("navigation", { name: copy.nav.label });

/** jsdom lays nothing out and scrolls nothing: a spy stands in for the scrolling of an anchor. */
let scrolledTo: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrolledTo = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrolledTo });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  resetWidth();
  config.features.signIn = true;
});

// ---- About ----

describe("the figures of the data", () => {
  const place = (country: string | undefined, createdAt: number) => ({ country, createdAt }) as never;

  it("counts the places, the countries they are in, and the newest time a place was written", () => {
    expect(aboutFigures([place("PT", 10), place("PT", 30), place("ES", 20)])).toEqual({ places: 3, countries: 2, refreshedAt: 30 });
  });

  it("counts a country once, whatever its case or spacing, and counts no place that has none", () => {
    expect(aboutFigures([place("pt", 1), place(" PT ", 1), place("Pt", 1), place(undefined, 1), place("", 1), place("  ", 1)])).toEqual({
      places: 6,
      countries: 1,
      refreshedAt: 1,
    });
  });

  it("has no time when there are no places", () => {
    expect(aboutFigures([])).toEqual({ places: 0, countries: 0, refreshedAt: undefined });
  });

  it("is what the fixtures hold", () => {
    expect(aboutFigures(places)).toEqual({ places: 43, countries: 1, refreshedAt: REFRESHED_AT });
  });
});

describe("the about page: where the places come from", () => {
  it("shows the figures of the places that are loaded: how many, in how many countries, and when they were refreshed", async () => {
    await openApp("/about", { events: fixtures });
    await waitFor(() => expect(figure(copy.about.figures.places)).toHaveTextContent("43"));
    expect(figure(copy.about.figures.countries)).toHaveTextContent("1");
    expect(figure(copy.about.figures.lastRefreshed)).toHaveTextContent("October 5, 2026");
    expect(figure(copy.about.figures.refreshed)).toHaveTextContent(copy.about.figures.monthly);
    expect(copy.about.figures.monthly).toBe("Every month");
  });

  it("works the figures out from the places: no number or date is written into the page", async () => {
    const later = REFRESHED_AT + 10 * DAY;
    const events = [
      ...fixtures,
      variant(jacafe, { d: "es-1", country: "ES" }, later),
      variant(jacafe, { d: "fr-1", country: "FR" }, later - DAY),
      variant(jacafe, { d: "fr-2", country: "FR" }, REFRESHED_AT - DAY),
    ];
    await openApp("/about", { events });
    await waitFor(() => expect(figure(copy.about.figures.places)).toHaveTextContent("46"));
    expect(figure(copy.about.figures.countries)).toHaveTextContent("3");
    // The newest of them, in the browser's language: 15 October 2026.
    expect(figure(copy.about.figures.lastRefreshed)).toHaveTextContent("October 15, 2026");
  });

  it("writes the date as the browser's language does, and the day it was in Greenwich, whatever time zone the person is in", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    await openApp("/about", { events: fixtures });
    // 23:25 UTC on the 5th is the 6th in Madeira in summer, which is not the day the places were refreshed.
    await waitFor(() => expect(figure(copy.about.figures.lastRefreshed)).toHaveTextContent("5 de outubro de 2026"));
    expect(figure(copy.about.figures.places)).toHaveTextContent("43");
  });

  it("writes the date in Latin digits, as every number the app writes, in any language", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("ar-EG");
    await openApp("/about", { events: fixtures });
    await waitFor(() => expect(figure(copy.about.figures.lastRefreshed)).not.toHaveTextContent(copy.about.figures.none));
    const date = figure(copy.about.figures.lastRefreshed).textContent ?? "";
    // 5 October 2026, in Arabic, with 5 and 2026 in the digits the rest of the page uses.
    expect(date).toMatch(/\b5\b/);
    expect(date).toContain("2026");
    expect(date).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
    expect(formatRefreshed(REFRESHED_AT, "ar-EG")).toBe(date);
  });

  it("opens before the places do, with a dash in place of each figure, and fills them in when they come", async () => {
    await openApp("/about", { events: fixtures, delayMs: 150 });
    // The page is not held back for the places: its words are there at once.
    expect(heading()).toHaveTextContent(copy.about.title);
    expect(screen.queryByText(copy.load.loading)).not.toBeInTheDocument();
    expect(figure(copy.about.figures.places)).toHaveTextContent(copy.about.figures.none);
    expect(figure(copy.about.figures.countries)).toHaveTextContent(copy.about.figures.none);
    expect(figure(copy.about.figures.lastRefreshed)).toHaveTextContent(copy.about.figures.none);
    // What does not depend on the places is there too.
    expect(figure(copy.about.figures.refreshed)).toHaveTextContent(copy.about.figures.monthly);

    await waitFor(() => expect(figure(copy.about.figures.places)).toHaveTextContent("43"));
    expect(figure(copy.about.figures.lastRefreshed)).toHaveTextContent("October 5, 2026");
  });

  it("says where the details come from in fine print, and links to the licence in a new tab", async () => {
    await openApp("/about", { events: fixtures });
    const source = screen.getByText(copy.about.source);
    expect(copy.about.source).toBe("Place details from OpenStreetMap, gathered for us by BTC Map");
    expect(source).toHaveClass("text-caption", "text-muted");
    // The design sets the licence sentence in 14 px; the line about where the details come from is the fine print.
    expect(screen.getByText(copy.about.licence)).toHaveClass("text-secondary", "text-muted");

    const licence = link(new RegExp(`^${copy.about.licenceLink}`));
    expect(licence).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(licence).toHaveAttribute("target", "_blank");
    expect(licence).toHaveAttribute("rel", "noopener noreferrer");
    expect(licence).toHaveAccessibleName(`${copy.about.licenceLink} ${copy.common.newTab}`);
    expect(licence).toHaveClass("min-h-touch");
  });

  it.each([390, 1360])("credits GeoNames for the towns' names in fine print, and links to their licence in a new tab, at %s px", async (px) => {
    await openApp("/about", { events: fixtures, px });
    const credit = screen.getByText(copy.about.townsSource);
    expect(copy.about.townsSource).toBe("Town names from GeoNames (geonames.org), CC BY 4.0.");
    expect(credit).toHaveClass("text-caption", "text-muted");
    // In the section on where the places come from, after OpenStreetMap's licence.
    expect(credit.closest("section")).toHaveAccessibleName(copy.about.placesHeading);
    expect(screen.getByText(copy.about.licence).compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const licence = link(new RegExp(`^${copy.about.townsLicenceLink}`));
    expect(licence).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
    expect(licence).toHaveAttribute("target", "_blank");
    expect(licence).toHaveAttribute("rel", "noopener noreferrer");
    expect(licence).toHaveAccessibleName(`${copy.about.townsLicenceLink} ${copy.common.newTab}`);
    expect(licence).toHaveClass("min-h-touch");
  });

  it.each([390, 1360])("links to the licences of the software the site is built from, at %s px", async (px) => {
    await openApp("/about", { events: fixtures, px });
    const software = link(new RegExp(`^${copy.about.softwareLicences}`));
    expect(copy.about.softwareLicences).toBe("Software licences");
    // A file the build writes next to the app (tools/notices.ts), so a plain link the router does not take.
    expect(software).toHaveAttribute("href", `/${NOTICES_FILE}`);
    expect(NOTICES_FILE).toBe("THIRD_PARTY_NOTICES.txt");
    expect(software).toHaveAttribute("target", "_blank");
    expect(software).toHaveAccessibleName(`${copy.about.softwareLicences} ${copy.common.newTab}`);
    expect(software).toHaveClass("min-h-touch");
  });

  it("names BTC Map only in that fine print", async () => {
    await openApp("/about", { events: fixtures });
    const mentions = screen.getAllByText(/BTC Map/);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toBe(screen.getByText(copy.about.source));
  });
});

describe("the about page: what it says", () => {
  it("is headed by what Regulars is, and has the four sections of the design", async () => {
    await openApp("/about", { events: fixtures });
    expect(heading()).toHaveTextContent("Places to eat and drink, rated by people you'd actually ask.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((each) => each.textContent)).toEqual([
      copy.about.placesHeading,
      copy.about.reviewsHeading,
      copy.about.houseHeading,
      copy.about.signingInHeading,
    ]);
    // "Your reviews are yours" is the dark card, which is not a heading of the outline.
    expect(screen.getByText(copy.about.yoursHeading)).toBeInTheDocument();
    expect(screen.getByText(copy.about.yoursBody)).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe(copy.titles.about));
  });

  it("explains House picks and My circle in plain words, where the reviews come from", async () => {
    await openApp("/about", { events: fixtures });
    const reviews = section(copy.about.reviewsHeading);
    expect(within(reviews).getByText(copy.about.reviewsBody)).toBeInTheDocument();
    const views = within(reviews).getByText(copy.about.viewsBody);
    expect(views).toHaveTextContent("House picks");
    expect(views).toHaveTextContent("My circle");
  });

  it("names the house curator", async () => {
    await openApp("/about", { events: fixtures });
    expect(houseBody()).toHaveTextContent(/^Mise en Place, our house curator/);
  });

  it.each([
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ])("puts the house's badge beside its name, 24 px and round, as decoration, on a %s", async (_, px) => {
    await openApp("/about", { events: fixtures, px });
    const badges = within(section(copy.about.houseHeading)).getAllByRole("presentation");
    expect(badges).toHaveLength(1);
    const badge = badges[0]!;
    // The name is in the text beside it, so the badge says nothing to a screen reader.
    expect(badge).toHaveAttribute("alt", "");
    expect(badge.parentElement!.textContent).toBe(copy.house.name);
    expect(badge.nextSibling?.textContent).toBe(copy.house.name);
    // The app's own file, four times the size it is drawn at, a little larger than in Explore's line.
    expect(badge).toHaveAttribute("src", houseBadge96);
    expect(badge).toHaveAttribute("width", "24");
    expect(badge).toHaveAttribute("height", "24");
    expect(badge).toHaveClass("size-6", "rounded-full");
    expect(houseBody()).toHaveTextContent(copy.about.houseBody);
  });

  it("says what House picks are once, and the house section points to it", async () => {
    await openApp("/about", { events: fixtures });
    // One paragraph defines them: scores from the reviewers the house trusts.
    const definitions = screen.getAllByText(/scores from the reviewers/);
    expect(definitions).toHaveLength(1);
    expect(section(copy.about.reviewsHeading)).toContainElement(definitions[0]!);
    // The house section names the house and what it does for House picks, in its own words.
    const house = houseBody();
    expect(house.textContent).toBe(copy.about.houseBody);
    expect(house).toHaveTextContent("House picks");
    expect(house).toHaveTextContent("keeps the list of places up to date");
  });

  it("has an anchor for how scores are worked out and one for how signing in works", async () => {
    await openApp("/about", { events: fixtures });
    expect(section(copy.about.reviewsHeading)).toHaveAttribute("id", "how-scores-work");
    expect(section(copy.about.signingInHeading)).toHaveAttribute("id", "signing-in");
  });

  it("has no address to write to, and no place where one will be", async () => {
    const { container } = await openApp("/about", { events: fixtures });
    expect(container.innerHTML).not.toMatch(/mailto:|Questions|CONTACT|\S+@\S+\.\S+/);
    expect(screen.queryByText(/question|contact|email/i)).not.toBeInTheDocument();
  });
});

describe("the about page: anchors", () => {
  it("scrolls to the section a link to it names, when the page is opened by the link", async () => {
    await openApp("/about#signing-in", { events: fixtures });
    await waitFor(() => expect(scrolledTo).toHaveBeenCalled());
    expect(scrolledTo.mock.contexts.at(-1)).toBe(section(copy.about.signingInHeading));
  });

  // Explore's "How this works" goes to the Why page now (tests/why.test.tsx); the section keeps its anchor.
  it("scrolls to how scores are worked out when a link names it", async () => {
    await openApp("/about#how-scores-work", { events: fixtures });
    await waitFor(() => expect(scrolledTo).toHaveBeenCalled());
    expect(scrolledTo.mock.contexts.at(-1)).toBe(section(copy.about.reviewsHeading));
  });

  it("scrolls to how signing in works from the sign-in page", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures });
    await user.click(link(copy.signin.howItWorks));
    expect(router.state.location.pathname + router.state.location.hash).toBe("/about#signing-in");
    await waitFor(() => expect(scrolledTo).toHaveBeenCalled());
    expect(scrolledTo.mock.contexts.at(-1)).toBe(section(copy.about.signingInHeading));
  });
});

describe("the about page: layout", () => {
  it("is one column on a phone, with the wordmark, the way back and no side rail", async () => {
    await openApp("/about", { events: fixtures });
    expect(screen.getByText(copy.app.name, { selector: "div" })).toHaveClass("text-accent");
    expect(link(copy.place.backHome)).toHaveAttribute("href", "/");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(tabBar()).not.toBeInTheDocument();
  });

  it("goes back the way the person came, in the word 'Back'", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/about", { events: fixtures, entries: ["/search?q=cafe", "/about"] });
    await user.click(link(copy.about.back));
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.historyAction).toBe("POP");
  });

  it("is a column and a rail on a desktop: the figures and the dark card beside the words", async () => {
    await openApp("/about", { events: fixtures, px: DESKTOP });
    const rail = screen.getByRole("complementary", { name: copy.about.railLabel });
    expect(rail).toHaveClass("w-rail");
    // The column and the rail are 40 px apart, as on the place and chain pages.
    expect(rail.parentElement).toHaveClass("gap-10");
    expect(within(rail).getByText(copy.about.figures.places, { selector: "dt" })).toBeInTheDocument();
    expect(within(rail).getByText(copy.about.yoursHeading)).toBeInTheDocument();
    expect(rail).not.toContainElement(heading());
    expect(rail).not.toContainElement(section(copy.about.reviewsHeading));
    // The top bar has the wordmark, so the page does not draw its own.
    expect(screen.getAllByText(copy.app.name)).toHaveLength(1);
    expect(link(copy.place.backHome)).toBeInTheDocument();
  });
});

// ---- Sign in ----

/** What the sign-in page is opened with when the toggle or a bookmark sent the person there from `from`. */
const from = (pathname: string, search = "", hash = "") => ({ pathname, search, hash, state: null, key: "abc" });
const signinFrom = (pathname: string, search = "") => ({ pathname: "/signin", state: { from: from(pathname, search) } });

describe("the sign-in page on a phone", () => {
  it("is a dark full screen with the headline, what happens, three numbered steps and the two buttons", async () => {
    await openApp("/signin", { events: fixtures });
    expect(heading()).toHaveTextContent("Ratings from people you'd actually ask.");
    expect(heading().closest(".bg-night")).not.toBeNull();
    expect(screen.getByText(copy.signin.intro)).toBeInTheDocument();
    expect(screen.getByText(copy.app.name, { selector: "div" })).toHaveClass("text-wordmark-on-night");

    const steps = within(screen.getByRole("list", { name: copy.signin.stepsLabel })).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(copy.signin.steps.map((text, i) => `${i + 1}${text}`));
    expect(copy.signin.steps).toHaveLength(3);

    expect(screen.getByRole("button", { name: copy.signin.continueButton })).toHaveTextContent("Continue with Nostr");
    expect(link(copy.signin.keepHousePicks)).toBeInTheDocument();
    expect(screen.getByText(copy.signin.notice)).toBeInTheDocument();
    expect(link(copy.signin.howItWorks)).toHaveAttribute("href", "/about#signing-in");
    await waitFor(() => expect(document.title).toBe(copy.titles.signin));
  });

  it("has nothing of the app around it: no tabs, no top bar", async () => {
    await openApp("/signin", { events: fixtures });
    expect(tabBar()).not.toBeInTheDocument();
    expect(banner()).not.toBeInTheDocument();
  });

  it("says nothing the app may not: the first step does not say 'follow'", () => {
    for (const step of copy.signin.steps) expect(step).not.toMatch(/follow/i);
    expect(copy.signin.steps[0]).toBe("Sign in. We read who you already trust.");
  });

  it("has Continue off, with why under it, while signing in is not open", async () => {
    config.features.signIn = false;
    await openApp("/signin", { events: fixtures });
    const button = screen.getByRole("button", { name: copy.signin.continueButton });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(copy.signin.comingSoon);
    expect(copy.signin.comingSoon).toBe("Signing in opens soon. Everything else works without it.");
    // The note is under the button, in the page's flow.
    const note = screen.getByText(copy.signin.comingSoon);
    expect(button.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps Continue in the keyboard's reach while it is off, so its note can be read, and it does nothing", async () => {
    config.features.signIn = false;
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, entries: ["/", signinFrom("/about")] });
    const button = screen.getByRole("button", { name: copy.signin.continueButton });
    // Not the native `disabled`, which takes a button out of the tab order and out of reach of its description.
    expect(button).not.toHaveAttribute("disabled");
    for (let i = 0; i < 5 && document.activeElement !== button; i += 1) await user.tab();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/signin");
  });

  it("has Continue on, with no note, once signing in is open", async () => {
    expect(config.features.signIn).toBe(true);
    await openApp("/signin", { events: fixtures });
    const button = screen.getByRole("button", { name: copy.signin.continueButton });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toBeEnabled();
    expect(screen.queryByText(copy.signin.comingSoon)).not.toBeInTheDocument();
  });

  it("puts the focus on the headline when the page opens, which a screen reader reads first", async () => {
    await openApp("/signin", { events: fixtures });
    expect(heading()).toHaveFocus();
    // Not in the tab order: Tab goes on to the first control.
    expect(heading()).toHaveAttribute("tabindex", "-1");
  });

  it("draws the focus ring white on the dark ground, where the ink ring would not show", async () => {
    await openApp("/signin", { events: fixtures });
    const onDark = (element: HTMLElement) => element.closest(".on-dark") !== null;
    for (const control of [
      link(copy.signin.close),
      screen.getByRole("button", { name: copy.signin.continueButton }),
      link(copy.signin.keepHousePicks),
      link(copy.signin.howItWorks),
    ]) {
      expect(onDark(control)).toBe(true);
    }
  });

  it("fits a phone of the design's height: the buttons are not pushed past the screen", async () => {
    await openApp("/signin", { events: fixtures });
    // 844 px is the design's frame. The group at the foot has no more room above it than the steps need.
    const group = link(copy.signin.keepHousePicks).parentElement!;
    expect(group).not.toHaveClass("pt-8");
    expect(group).toHaveClass("pt-3");
  });

  it("draws Continue white and Keep House picks outlined, as SignIn.dc.html does", async () => {
    await openApp("/signin", { events: fixtures });
    expect(screen.getByRole("button", { name: copy.signin.continueButton })).toHaveClass("bg-ground", "text-ink", "h-14");
    expect(link(copy.signin.keepHousePicks)).toHaveClass("border-muted", "h-13");
  });
});

describe("the sign-in page on a desktop", () => {
  it("is the headline on the left and the steps and buttons in a white card on the right, with no top bar", async () => {
    config.features.signIn = false;
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    expect(banner()).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent(copy.signin.headline);
    expect(heading().closest(".bg-night")).not.toBeNull();

    const button = screen.getByRole("button", { name: copy.signin.continueButton });
    const card = button.closest(".bg-ground")!;
    expect(card).toHaveClass("rounded-dialog");
    expect(within(card as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
    expect(card).not.toContainElement(heading());
    expect(within(card as HTMLElement).getByText(copy.signin.notice)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole("link", { name: copy.signin.howItWorks })).toBeInTheDocument();
    // On the white card Continue is the accent colour.
    expect(button).toHaveClass("bg-accent-solid", "text-on-accent");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(copy.signin.comingSoon);
  });

  it("draws the ring white on the dark ground and keeps the ink ring on the white card", async () => {
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    // The wordmark and the cross are on the dark ground.
    expect(link(copy.app.name).closest(".on-dark")).not.toBeNull();
    expect(link(copy.signin.close).closest(".on-dark")).not.toBeNull();
    // The card's controls are on white: a white ring there would be invisible.
    for (const control of [
      screen.getByRole("button", { name: copy.signin.continueButton }),
      link(copy.signin.keepHousePicks),
      link(copy.signin.howItWorks),
    ]) {
      expect(control.closest(".on-dark")).toBeNull();
    }
  });

  it("puts the focus on the headline when the page opens", async () => {
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    expect(heading()).toHaveFocus();
    expect(heading()).toHaveAttribute("tabindex", "-1");
  });

  it("has the wordmark, which goes to Explore", async () => {
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    expect(link(copy.app.name)).toHaveAttribute("href", "/");
  });
});

describe("leaving the sign-in page", () => {
  type Leave = [name: string, leave: (user: ReturnType<typeof userEvent.setup>) => Promise<void>];
  const ways: Leave[] = [
    ["Keep House picks", (user) => user.click(link(copy.signin.keepHousePicks))],
    ["the close control", (user) => user.click(link(copy.signin.close))],
    ["Escape", (user) => user.keyboard("{Escape}")],
  ];

  describe.each(ways)("with %s", (_, leave) => {
    it("goes back to the page the person was on, one step back, when there is one", async () => {
      const user = userEvent.setup();
      const entries = ["/", "/about", signinFrom("/about")];
      const { router } = await openApp("/signin", { events: fixtures, entries });
      await leave(user);
      expect(router.state.location.pathname).toBe("/about");
      expect(router.state.historyAction).toBe("POP");
      // The one before it is still behind it: nothing was added to the history.
      expect(router.state.historyAction).not.toBe("PUSH");
    });

    it("keeps the search and the filters of the page it was opened from", async () => {
      const user = userEvent.setup();
      const entries = ["/search?q=bakery&open=1", signinFrom("/search", "?q=bakery&open=1")];
      const { router } = await openApp("/signin", { events: fixtures, entries });
      await leave(user);
      expect(router.state.location.pathname + router.state.location.search).toBe("/search?q=bakery&open=1");
    });

    it("goes to the page it was opened from when that is the only page in the history", async () => {
      const user = userEvent.setup();
      const { router } = await openApp("/signin", { events: fixtures, entries: [signinFrom("/about")] });
      await leave(user);
      expect(router.state.location.pathname).toBe("/about");
      // In place of the sign-in page, so Back does not return to it.
      expect(router.state.historyAction).toBe("REPLACE");
    });

    it("goes to Explore when it does not know where the person was", async () => {
      const user = userEvent.setup();
      const { router } = await openApp("/signin", { events: fixtures });
      await leave(user);
      expect(router.state.location.pathname).toBe("/");
      expect(router.state.historyAction).toBe("REPLACE");
    });

    it.each([
      ["another site", { from: { pathname: "https://example.com/" } }],
      ["a path that is not in the app", { from: { pathname: "//example.com/path" } }],
      ["the sign-in page itself", { from: from("/signin") }],
      ["no address", { from: {} }],
      ["not an object", { from: "/about" }],
      ["nothing", {}],
    ])("goes to Explore when where it came from is %s", async (_, state) => {
      const user = userEvent.setup();
      const { router } = await openApp("/signin", { events: fixtures, entries: [{ pathname: "/signin", state }] });
      await leave(user);
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("is the way out on a desktop too", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, px: DESKTOP, entries: ["/about", signinFrom("/about")] });
    await user.click(link(copy.signin.keepHousePicks));
    expect(router.state.location.pathname).toBe("/about");
  });

  it("does not take a new tab's or window's click for its own: the link is the page it goes to", async () => {
    await openApp("/signin", { events: fixtures, entries: ["/about", signinFrom("/about")] });
    expect(link(copy.signin.keepHousePicks)).toHaveAttribute("href", "/about");
    expect(link(copy.signin.close)).toHaveAttribute("href", "/about");
  });

  it("hears Escape only while the sign-in page is open", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, entries: ["/", signinFrom("/saved")] });
    await act(() => router.navigate("/about"));
    await user.keyboard("{Escape}");
    expect(router.state.location.pathname).toBe("/about");
  });
});

// ---- Saved and You, before sign in opens ----

describe.each([
  ["/saved", copy.pages.saved, copy.titles.saved, copy.saved.signedOut, "Sign in to save places and make lists you can share."],
  ["/you", copy.pages.you, copy.titles.you, copy.you.signedOut, "Sign in to see your reviews and the people you trust."],
] as const)("%s, before sign in opens", (path, name, title, sentence, words) => {
  it("asks the person to sign in, in a sentence of its own and a button", async () => {
    await openApp(path, { events: fixtures });
    expect(heading()).toHaveTextContent(name);
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(sentence).toBe(words);
    expect(screen.getByRole("link", { name: copy.signin.button })).toHaveAttribute("href", "/signin");
    await waitFor(() => expect(document.title).toBe(title));
  });

  it("takes the person to sign in, which can bring them back here", async () => {
    const user = userEvent.setup();
    const { router } = await openApp(path, { events: fixtures });
    await user.click(screen.getByRole("link", { name: copy.signin.button }));
    expect(router.state.location.pathname).toBe("/signin");
    expect((router.state.location.state as { from: { pathname: string } }).from.pathname).toBe(path);

    await user.click(link(copy.signin.keepHousePicks));
    expect(router.state.location.pathname).toBe(path);
  });

  it("has the tabs on a phone, and does not wait for the places", async () => {
    await openApp(path, { events: fixtures });
    expect(tabBar()).toBeInTheDocument();
    // Saved is no tab until saved lists open (config.features.saved): on it, no tab is the page that is open.
    if (path === "/saved") expect(within(tabBar()!).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    else expect(within(tabBar()!).getByRole("link", { name: name })).toHaveAttribute("aria-current", "page");
  });

  it("is the page of the top bar on a desktop, with no tabs", async () => {
    await openApp(path, { events: fixtures, px: DESKTOP });
    expect(banner()).toBeInTheDocument();
    expect(tabBar()).not.toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
});
