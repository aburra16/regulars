import type { NostrEvent } from "@nostrify/nostrify";
import OpeningHours from "opening_hours";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { CLOSING_SOON_MINUTES, type OpenState, PARSE_CACHE_LIMIT, openLine, openState, timeZoneOf, weekTable } from "../src/places/hours";
import { parsePlace } from "../src/places/place";
import raw from "./fixtures/funchal-items.json";

// The real parser, wrapped so the tests can count how often it is built and with what.
vi.mock("opening_hours", async (importOriginal) => {
  const original = await importOriginal<typeof import("opening_hours")>();
  const Spied = vi.fn(function (...args: ConstructorParameters<typeof original.default>) {
    return new original.default(...args);
  });
  return { ...original, default: Spied };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Funchal is on Atlantic/Madeira: UTC+1 in summer (until 25 Oct 2026), UTC+0 in winter.
// vitest.config.ts runs the tests with TZ=UTC, so a result that leaks the runtime's zone shows up.
// `now` is always a real instant (an ISO string with Z). `closesAt` and `opensAt` are wall-clock
// Dates, so they are compared with `new Date(y, m, d, h, min)`, which uses the same fields.
interface Where {
  lat: number;
  lon: number;
  country?: string;
}
const FUNCHAL: Where = { lat: 32.6507, lon: -16.9084, country: "PT" };
const TOKYO: Where = { lat: 35.6762, lon: 139.6503, country: "JP" };

const at = (iso: string) => new Date(iso);
const stateOf = (openingHours: string | undefined, iso: string, where: Where = FUNCHAL) =>
  openState({ ...where, openingHours }, at(iso));
const lineOf = (openingHours: string | undefined, iso: string, locale = "en-US", form: Parameters<typeof openLine>[2] = "card") =>
  openLine(stateOf(openingHours, iso), locale, form);

// Wed 7 Oct 2026, Madeira on summer time: 14:00Z is 15:00 there, 22:30Z is 23:30.
const WED_15_00 = "2026-10-07T14:00:00Z";
const WED_23_30 = "2026-10-07T22:30:00Z";

describe("timeZoneOf", () => {
  it("names the IANA zone of a coordinate", () => {
    expect(timeZoneOf(FUNCHAL.lat, FUNCHAL.lon)).toBe("Atlantic/Madeira");
    expect(timeZoneOf(38.7223, -9.1393)).toBe("Europe/Lisbon");
    expect(timeZoneOf(TOKYO.lat, TOKYO.lon)).toBe("Asia/Tokyo");
  });
});

describe("openState", () => {
  it("runs the tests in UTC, so the runtime zone is not the place's zone", () => {
    expect(new Date(2026, 9, 7, 12).getTimezoneOffset()).toBe(0);
  });

  describe("open", () => {
    it("is open with the closing time on the place's clock", () => {
      expect(stateOf("Mo-Su 11:00-23:00", WED_15_00)).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 7, 23, 0),
      });
    });

    it("has no closing time for 24/7 or all-day hours", () => {
      expect(stateOf("24/7", WED_15_00)).toEqual({ kind: "open" });
      expect(stateOf("Mo-Su 00:00-24:00", WED_15_00)).toEqual({ kind: "open" });
    });

    it("has no closing time when nothing closes it this week", () => {
      // Closed on 25 December, which is not this week.
      expect(stateOf("24/7; Dec 25 off", WED_15_00)).toEqual({ kind: "open" });
      // ...while a closure this week is a closing time.
      expect(stateOf("Mo-Su 11:00-23:00; Dec 25 off", WED_15_00)).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 7, 23, 0),
      });
    });

    it("closes after midnight when the hours run past it", () => {
      // Fri 9 Oct, 23:30 Madeira: the Friday and Saturday rule runs to 02:00.
      expect(stateOf("Mo-Sa 11:00-24:00, Fr-Sa 11:00-02:00", "2026-10-09T22:30:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 10, 2, 0),
      });
    });

    it("marks a closing more than 24 hours away, and only then", () => {
      // Wed 7 Oct 15:00 Madeira, open round the clock Monday to Friday: closes Sat 00:00.
      expect(stateOf("Mo-Fr 00:00-24:00", WED_15_00)).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 10, 0, 0),
        closesAfterADay: true,
      });
      // Fri 9 Oct 15:00, the same hours: closes in 9 hours.
      expect(stateOf("Mo-Fr 00:00-24:00", "2026-10-09T14:00:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 10, 0, 0),
      });
    });

    it("closes at midnight for hours that end at 24:00", () => {
      expect(stateOf("Mo-Su 09:30-24:00", WED_23_30)).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 8, 0, 0),
        closingSoon: true,
      });
    });
  });

  describe("closing soon (Avi, 2026-10-09)", () => {
    // Wed 7 Oct, Madeira on summer time (UTC+1): open until 23:00 there, 22:00Z.
    const ELEVEN = "Mo-Su 11:00-23:00";

    it("is 45 minutes", () => {
      expect(CLOSING_SOON_MINUTES).toBe(45);
    });

    it("is open with 46 minutes left, and closing soon with 45, on the place's clock", () => {
      // 22:14 and 22:15 in Madeira.
      expect(stateOf(ELEVEN, "2026-10-07T21:14:00Z")).toEqual({ kind: "open", closesAt: new Date(2026, 9, 7, 23, 0) });
      expect(stateOf(ELEVEN, "2026-10-07T21:15:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 7, 23, 0),
        closingSoon: true,
      });
    });

    it("counts the seconds: 45 minutes and a second left is not yet soon, 44 minutes and 59 seconds is", () => {
      expect(stateOf(ELEVEN, "2026-10-07T21:14:59Z")).not.toHaveProperty("closingSoon");
      expect(stateOf(ELEVEN, "2026-10-07T21:15:01Z")).toHaveProperty("closingSoon", true);
      expect(stateOf(ELEVEN, "2026-10-07T21:59:00Z")).toHaveProperty("closingSoon", true);
    });

    it("is soon for hours that close after midnight, across it and after it", () => {
      // Fri 9 Oct 23:20 Madeira: open until 02:00, 2 h 40 min away.
      const late = "Mo-Sa 11:00-24:00, Fr-Sa 11:00-02:00";
      expect(stateOf(late, "2026-10-09T22:20:00Z")).toEqual({ kind: "open", closesAt: new Date(2026, 9, 10, 2, 0) });
      // Sat 10 Oct 01:20: 40 minutes.
      expect(stateOf(late, "2026-10-10T00:20:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 10, 2, 0),
        closingSoon: true,
      });
      // Wed 23:50, open until 00:30 Thursday: 40 minutes, across midnight.
      expect(stateOf("Mo-Su 17:00-00:30", "2026-10-07T22:50:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 8, 0, 30),
        closingSoon: true,
      });
    });

    it("is never soon for a place open all day, or with no closing time this week, or closed", () => {
      expect(stateOf("24/7", "2026-10-07T21:30:00Z")).toEqual({ kind: "open" });
      expect(stateOf("Mo-Su 00:00-24:00", "2026-10-07T22:50:00Z")).toEqual({ kind: "open" });
      expect(stateOf("24/7; Dec 25 off", "2026-10-07T22:50:00Z")).toEqual({ kind: "open" });
      expect(stateOf(ELEVEN, "2026-10-07T22:30:00Z")).not.toHaveProperty("closingSoon");
      // Ten minutes before it opens: closed, not soon to anything.
      expect(stateOf(ELEVEN, "2026-10-08T09:50:00Z")).toEqual({ kind: "closed", opensAt: new Date(2026, 9, 8, 11, 0) });
    });

    it("says so in its own words (Avi, 2026-10-09): 'Closing soon · 11 pm', and 'Closing soon, 11 pm' inside a line", () => {
      const soon = stateOf(ELEVEN, "2026-10-07T21:30:00Z");
      expect(soon).toHaveProperty("closingSoon", true);
      expect(openLine(soon, "en-US", "card")).toBe("Closing soon · 11 pm");
      expect(openLine(soon, "en-US", "place")).toBe("Closing soon · 11 pm");
      expect(openLine(soon, "en-US", "placeInline")).toBe("Closing soon, 11 pm");
      expect(openLine(soon, "pt-PT", "card")).toBe("Closing soon · 23:00");
    });

    it("says it from 45 minutes left, and 'Open until' with 46", () => {
      for (const [form, open, soon] of [
        ["card", "Open until 11 pm", "Closing soon · 11 pm"],
        ["place", "Open now · closes 11 pm", "Closing soon · 11 pm"],
        ["placeInline", "Open now, closes 11 pm", "Closing soon, 11 pm"],
      ] as const) {
        expect(lineOf(ELEVEN, "2026-10-07T21:14:00Z", "en-US", form)).toBe(open);
        expect(lineOf(ELEVEN, "2026-10-07T21:15:00Z", "en-US", form)).toBe(soon);
      }
    });
  });

  describe("closed", () => {
    it("is closed with the next opening on the place's clock", () => {
      expect(stateOf("Mo-Su 11:00-23:00", WED_23_30)).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 8, 11, 0),
      });
    });

    it("is closed with no next opening when the hours say it is shut for good", () => {
      expect(stateOf("off", WED_15_00)).toEqual({ kind: "closed" });
      expect(stateOf(" Closed ", WED_15_00)).toEqual({ kind: "closed" });
    });

    it("is closed with no weekday when it does not open for more than a week", () => {
      // A season starting in April: "opens Thu" would mislead.
      expect(stateOf("Apr-Sep Mo-Su 11:00-23:00", WED_15_00)).toEqual({ kind: "closed" });
    });

    it("names the weekday of an opening up to a week away", () => {
      // Sat 10 Oct 13:00 Madeira, the one weekly slot ended an hour ago: next Saturday, 6 days 21 hours.
      expect(stateOf("Sa 10:00-12:00", "2026-10-10T12:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 17, 10, 0),
        opensAfterADay: true,
      });
    });

    it("marks an opening more than 24 hours away, and only then", () => {
      // Fri 9 Oct 18:00 Madeira, opens Mon 12 Oct 09:00.
      expect(stateOf("Mo-Fr 09:00-17:00", "2026-10-09T17:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 12, 9, 0),
        opensAfterADay: true,
      });
      // Tue 6 Oct 12:00:00 Madeira, opens Wed 12:00: exactly 24 hours is not more than 24 hours.
      expect(stateOf("We 12:00-13:00", "2026-10-06T11:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 7, 12, 0),
      });
      // One second earlier, it is.
      expect(stateOf("We 12:00-13:00", "2026-10-06T10:59:59Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 7, 12, 0),
        opensAfterADay: true,
      });
    });
  });

  describe("the place's time zone", () => {
    it("uses the place's clock, not the UTC clock", () => {
      // 22:30Z reads 22:30 in UTC (open until 23:00) and 23:30 in Funchal (closed).
      expect(stateOf("Mo-Su 11:00-23:00", WED_23_30).kind).toBe("closed");
    });

    it("follows summer and winter time", () => {
      // The same 22:30Z in December: Madeira is on UTC+0, so it reads 22:30 and the place is open,
      // for half an hour more.
      expect(stateOf("Mo-Su 11:00-23:00", "2026-12-07T22:30:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 11, 7, 23, 0),
        closingSoon: true,
      });
    });

    it("works for a place far from the runtime's zone", () => {
      // Tokyo is UTC+9: 13:59Z is 22:59 there, a minute before it closes, 14:00Z is 23:00.
      expect(stateOf("Mo-Su 11:00-23:00", "2026-10-07T13:59:00Z", TOKYO)).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 7, 23, 0),
        closingSoon: true,
      });
      expect(stateOf("Mo-Su 11:00-23:00", "2026-10-07T14:00:00Z", TOKYO)).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 8, 11, 0),
      });
    });

    it("reads the weekday on the place's calendar", () => {
      // 15:30Z on Tue 6 Oct is already Wed 00:30 in Tokyo (UTC+9), where a Wednesday-only place is
      // open; in Funchal it is Tue 16:30.
      expect(stateOf("We 00:00-02:00", "2026-10-06T15:30:00Z", TOKYO).kind).toBe("open");
      expect(stateOf("We 00:00-02:00", "2026-10-06T15:30:00Z").kind).toBe("closed");
    });
  });

  describe("public holidays", () => {
    it("uses the place's country", () => {
      // Fri 25 Dec 2026, Christmas Day in Portugal. Madeira is UTC+0 in winter.
      expect(stateOf("Mo-Su 11:00-23:00; PH off", "2026-12-25T15:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 11, 26, 11, 0),
      });
      expect(stateOf("Mo-Su 11:00-23:00; PH off", "2026-12-24T15:00:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 11, 24, 23, 0),
      });
    });

    it("accepts a country in any letter case", () => {
      expect(stateOf("Mo-Su 11:00-23:00; PH off", "2026-12-25T15:00:00Z", { ...FUNCHAL, country: "pt" }).kind).toBe(
        "closed",
      );
    });

    it("cannot judge a holiday rule without a country", () => {
      const { lat, lon } = FUNCHAL;
      expect(stateOf("Mo-Su 11:00-23:00; PH off", "2026-12-25T15:00:00Z", { lat, lon })).toEqual({
        kind: "unparsed",
        raw: "Mo-Su 11:00-23:00; PH off",
      });
    });

    it("needs no country for hours with no holiday rule", () => {
      const { lat, lon } = FUNCHAL;
      expect(stateOf("Mo-Su 11:00-23:00", WED_15_00, { lat, lon }).kind).toBe("open");
    });
  });

  describe("no hours", () => {
    it("is unknown when there are no hours", () => {
      expect(stateOf(undefined, WED_15_00)).toEqual({ kind: "unknown" });
    });

    it("is unknown for an empty or whitespace-only string", () => {
      expect(stateOf("", WED_15_00)).toEqual({ kind: "unknown" });
      expect(stateOf("   \t\n", WED_15_00)).toEqual({ kind: "unknown" });
    });
  });

  describe("hours the app cannot read", () => {
    it("keeps the raw text of hours the parser had to guess at", () => {
      // The parser quietly repairs "as" into "-"; the app shows what the mapper wrote instead.
      expect(stateOf("16:00 as 23:00", WED_15_00)).toEqual({ kind: "unparsed", raw: "16:00 as 23:00" });
      expect(stateOf("Mon-Fri 09:00 to 17:00", WED_15_00)).toEqual({
        kind: "unparsed",
        raw: "Mon-Fri 09:00 to 17:00",
      });
      expect(stateOf("9-5", WED_15_00).kind).toBe("unparsed");
    });

    it("keeps the raw text of hours that do not parse", () => {
      for (const bad of ["hello world", "Mo-Su 25:00-26:00", "; ; ;", "🍝"]) {
        expect(stateOf(bad, WED_15_00)).toEqual({ kind: "unparsed", raw: bad });
      }
    });

    it("keeps the raw text of hours that only list closures, or have run out", () => {
      for (const odd of ["PH off", "Dec 25 off", "Su off", "2025 Mo-Su 10:00-12:00"]) {
        expect(stateOf(odd, WED_15_00)).toEqual({ kind: "unparsed", raw: odd });
      }
    });

    it("answers at once for hours the parser would grind on", () => {
      // The parser's default search for the next change takes about 40 seconds on "PH off". The
      // test timeout (5 s) is the check; so is the length limit on the 20,000-character string.
      expect(stateOf("PH off", WED_15_00).kind).toBe("unparsed");
      expect(stateOf("Mo-Su 11:00-23:00 ".repeat(200), WED_15_00).kind).toBe("unparsed");
      expect(stateOf("x".repeat(20000), WED_15_00).kind).toBe("unparsed");
    });

    it("reads hours up to the 255 characters OpenStreetMap allows, and no more", () => {
      const rule = "Mo-Fr 08:00-12:00,13:00-17:00; ";
      const longest = rule.repeat(8).slice(0, 255).replace(/[; ]+$/, "");
      expect(longest.length).toBeLessThanOrEqual(255);
      expect(stateOf(longest, WED_15_00).kind).toBe("open");
      expect(stateOf(`${longest}; Sa 10:00-12:00${"; Su off".repeat(10)}`, WED_15_00).kind).toBe("unparsed");
    });

    it("keeps the raw text when the open state is unknown", () => {
      // "Sa 09:00+" opens at 09:00 and gives no closing time; the parser can only guess one.
      const hours = "Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+";
      expect(stateOf(hours, "2026-10-10T14:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      expect(stateOf("Mo-Su 12:00-22:00 unknown", WED_15_00)).toEqual({
        kind: "unparsed",
        raw: "Mo-Su 12:00-22:00 unknown",
      });
    });

    describe("when the next change leads into an unknown state", () => {
      // "Opens at 12 am" would be a claim the hours do not make: the change is into "unknown".
      it("does not call a comment-only rule an opening", () => {
        const hours = 'Mo-Fr 09:00-17:00; Sa,Su "appointment only"';
        expect(stateOf(hours, "2026-10-09T18:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      });

      it("does not call an unknown rule an opening", () => {
        const hours = "Mo-Fr 08:00-17:00; Sa 09:00-12:00 unknown";
        expect(stateOf(hours, "2026-10-09T18:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      });

      it("does not call the end of an open-ended range an opening", () => {
        const hours = "Th-Su 11:00-21:00+";
        // Thu 8 Oct 22:00 Madeira.
        expect(stateOf(hours, "2026-10-08T21:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      });

      it("does not call a commented opening an opening", () => {
        const hours = 'Mo-Fr 08:00-17:00 "by appointment only"';
        // Wed 7 Oct 20:00 Madeira; and Sat 10 Oct, when the next change is Monday morning.
        expect(stateOf(hours, "2026-10-07T19:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
        expect(stateOf(hours, "2026-10-10T09:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      });

      it("does not call an open place's change into unknown a closing time", () => {
        const hours = "Mo-Fr 09:00-17:00+";
        // Wed 7 Oct 10:00 Madeira: open, and at 17:00 it goes to "unknown".
        expect(stateOf(hours, "2026-10-07T09:00:00Z")).toEqual({ kind: "unparsed", raw: hours });
      });

      it("still reads a plain opening that comes before an unknown one", () => {
        const hours = "Mo-Fr 09:00-17:00; Sa 09:00-12:00 unknown";
        // Fri 9 Oct 10:00 Madeira: it closes at 17:00 and the next change is a plain closing.
        expect(stateOf(hours, "2026-10-09T09:00:00Z")).toEqual({ kind: "open", closesAt: new Date(2026, 9, 9, 17, 0) });
        // Sat 10 Oct 13:00: Monday 09:00 is a plain opening.
        expect(stateOf(hours, "2026-10-10T12:00:00Z").kind).toBe("closed");
      });
    });

    it("still reads the weekdays of hours with an open-ended Saturday", () => {
      const hours = "Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+";
      expect(stateOf(hours, WED_15_00)).toEqual({ kind: "open", closesAt: new Date(2026, 9, 7, 17, 0) });
      expect(stateOf(hours, "2026-10-07T11:30:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 7, 13, 0),
      });
    });

    it("does not guess at sunrise and sunset, which the parser works out in the runtime's zone", () => {
      expect(stateOf("sunrise-sunset", WED_15_00)).toEqual({ kind: "unparsed", raw: "sunrise-sunset" });
      expect(stateOf("Mo-Su sunrise-sunset", WED_15_00).kind).toBe("unparsed");
      expect(stateOf("Mo-Su 10:00-dusk", WED_15_00).kind).toBe("unparsed");
    });

    it("never throws, whatever the hours or the place", () => {
      const hours = [
        "PH off",
        "sunrise-sunset",
        "Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+",
        "16:00 as 23:00",
        "",
        " ",
        "\u0000",
        "🍝",
        "Mo-Su",
        "24/7; PH off",
        "Dec 25 off",
        "week 1-53/2 Mo 10:00-12:00",
        "Mo-Su 11:00-23:00 ".repeat(200),
        "x".repeat(20000),
      ];
      const places: Where[] = [FUNCHAL, { lat: FUNCHAL.lat, lon: FUNCHAL.lon }, { ...FUNCHAL, country: "ZZ" }];
      const kinds: ReadonlySet<string> = new Set(["open", "closed", "unknown", "unparsed"]);
      for (const where of places) {
        for (const openingHours of hours) {
          const state = stateOf(openingHours, WED_15_00, where);
          expect(kinds.has(state.kind)).toBe(true);
          for (const form of ["card", "place"] as const) {
            const line = openLine(state, "en-US", form);
            expect(line.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("gives raw text for a place with a country the parser has no holidays for", () => {
      expect(stateOf("Mo-Su 11:00-23:00; PH off", WED_15_00, { ...FUNCHAL, country: "ZZ" }).kind).toBe("unparsed");
      expect(stateOf("Mo-Su 11:00-23:00", WED_15_00, { ...FUNCHAL, country: "ZZ" }).kind).toBe("open");
    });

    it("gives raw text when the coordinates have no time zone", () => {
      const state = openState({ openingHours: "Mo-Su 11:00-23:00", lat: 999, lon: 0 }, at(WED_15_00));
      expect(state).toEqual({ kind: "unparsed", raw: "Mo-Su 11:00-23:00" });
    });
  });

  describe("the Funchal fixtures", () => {
    const events: NostrEvent[] = raw;
    const places = events.flatMap((event) => {
      const place = parsePlace(event, config.headerCoordinate);
      return place?.openingHours === undefined ? [] : [place];
    });

    it("has real hours to read", () => {
      expect(places.length).toBeGreaterThan(30);
    });

    it("reads every hours string as open or closed, at any hour of a week", () => {
      const week = Array.from({ length: 7 * 24 }, (_, i) => new Date(Date.UTC(2026, 9, 5) + i * 3_600_000));
      const unread = places.flatMap((place) =>
        week.flatMap((instant) => {
          const { kind } = openState(place, instant);
          const where = `${place.openingHours} at ${instant.toISOString()}`;
          return kind === "open" || kind === "closed" ? [] : [`${where}: ${kind}`];
        }),
      );
      expect(unread).toEqual([]);
    });

    it("reports an opensAt that is open and a closesAt that is closed, as the parser itself says", () => {
      const oracle = (hours: string) =>
        new OpeningHours(hours, { lat: FUNCHAL.lat, lon: FUNCHAL.lon, address: { country_code: "pt", state: "" } });
      // The fixtures have no unknown states, so add hours that do: comments, "unknown", open ends.
      const awkward = [
        'Mo-Fr 09:00-17:00; Sa,Su "appointment only"',
        "Mo-Fr 08:00-17:00; Sa 09:00-12:00 unknown",
        "Th-Su 11:00-21:00+",
        'Mo-Fr 08:00-17:00 "by appointment only"',
        "Mo-Fr 09:00-17:00+",
        "Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+",
      ].map((openingHours) => ({ ...FUNCHAL, openingHours }));
      const week = Array.from({ length: 7 * 24 }, (_, i) => new Date(Date.UTC(2026, 9, 5) + i * 3_600_000));
      const wrong = [...places, ...awkward].flatMap((place) => {
        // Parsed once a place: parsing it again at each of the week's hours made this test outlast CI's 5 s.
        const hours = oracle(place.openingHours ?? "");
        return week.flatMap((instant) => {
          const state = openState(place, instant);
          const where = `${place.openingHours} at ${instant.toISOString()}`;
          if (state.kind === "closed" && state.opensAt !== undefined) {
            const opens = hours.getState(state.opensAt) && !hours.getUnknown(state.opensAt);
            return opens ? [] : [`${where}: opensAt ${state.opensAt.toString()} is not open`];
          }
          if (state.kind === "open" && state.closesAt !== undefined) {
            const closes = !hours.getState(state.closesAt) && !hours.getUnknown(state.closesAt);
            return closes ? [] : [`${where}: closesAt ${state.closesAt.toString()} is not closed`];
          }
          return [];
        });
      });
      expect(wrong).toEqual([]);
    });

    it("tells open from closed for hours with ';' and ','", () => {
      // "Mo-Fr 10:30-19:30, Sa 10:00-14:00": Sat 10 Oct 12:00 Madeira (11:00Z) it is open until 14:00.
      const hours = "Mo-Fr 10:30-19:30, Sa 10:00-14:00";
      expect(stateOf(hours, "2026-10-10T11:00:00Z")).toEqual({ kind: "open", closesAt: new Date(2026, 9, 10, 14, 0) });
      // ...and from 15:00 it is shut until Monday.
      expect(stateOf(hours, "2026-10-10T14:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 12, 10, 30),
        opensAfterADay: true,
      });

      // "Mo-Fr 07:30-20:00; Sa, Su 07:30-19:00": Sunday 11 Oct, 18:30 (half an hour before it closes) and 19:30 Madeira.
      const weekend = "Mo-Fr 07:30-20:00; Sa, Su 07:30-19:00";
      expect(stateOf(weekend, "2026-10-11T17:30:00Z")).toEqual({
        kind: "open",
        closesAt: new Date(2026, 9, 11, 19, 0),
        closingSoon: true,
      });
      expect(stateOf(weekend, "2026-10-11T18:30:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 12, 7, 30),
      });

      // "We-Su 12:00-22:00, Mo-Tu Closed": Tuesday 6 Oct, 15:00 Madeira.
      expect(stateOf("We-Su 12:00-22:00, Mo-Tu Closed", "2026-10-06T14:00:00Z")).toEqual({
        kind: "closed",
        opensAt: new Date(2026, 9, 7, 12, 0),
      });
    });
  });
});

describe("openLine", () => {
  describe("card", () => {
    it("says when an open place closes, in the locale's clock", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "en-US")).toBe("Open until 11 pm");
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "pt-PT")).toBe("Open until 23:00");
    });

    it("says when a closed place opens", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_23_30, "en-US")).toBe("Closed · opens 11 am");
      expect(lineOf("Mo-Su 11:00-23:00", WED_23_30, "pt-PT")).toBe("Closed · opens 11:00");
    });

    it("adds the weekday when the place opens more than a day away", () => {
      // Fri 9 Oct 18:00 Madeira, opens Mon 12 Oct 09:00.
      const friday = "2026-10-09T17:00:00Z";
      expect(lineOf("Mo-Fr 09:00-17:00", friday, "en-US")).toBe("Closed · opens Mon 9 am");
      expect(lineOf("Mo-Fr 09:00-17:00", friday, "en-GB")).toBe("Closed · opens Mon 09:00");
      // The words are English whatever the locale; only the clock follows the locale.
      expect(lineOf("Mo-Fr 09:00-17:00", friday, "pt-PT")).toBe("Closed · opens Mon 09:00");
      expect(lineOf("Mo-Fr 09:00-17:00", friday, "ja-JP")).toBe("Closed · opens Mon 09:00");
      expect(lineOf("Mo-Fr 09:00-17:00", friday, "de-DE", "place")).toBe("Closed · opens Mon 09:00");
    });

    it("names every weekday from the copy module, Monday first", () => {
      expect(copy.hours.weekdaysShort).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      // 2026-10-12 is a Monday. Each place below opens on its day, a few days after Friday evening.
      const friday = "2026-10-09T17:00:00Z";
      const opensOn = (days: string) => lineOf(`${days} 09:00-17:00`, friday, "pt-PT");
      expect(opensOn("Mo")).toBe("Closed · opens Mon 09:00");
      expect(opensOn("Tu")).toBe("Closed · opens Tue 09:00");
      expect(opensOn("We")).toBe("Closed · opens Wed 09:00");
      expect(opensOn("Th")).toBe("Closed · opens Thu 09:00");
      expect(lineOf("Fr 09:00-17:00", "2026-10-10T17:00:00Z", "pt-PT")).toBe("Closed · opens Fri 09:00");
      // Sun 11 Oct 18:00 Madeira: the next Saturday is five days off.
      expect(lineOf("Sa 09:00-17:00", "2026-10-11T17:00:00Z", "pt-PT")).toBe("Closed · opens Sat 09:00");
      expect(lineOf("Su 09:00-17:00", friday, "pt-PT")).toBe("Closed · opens Sun 09:00");
    });

    it("adds the weekday when the place stays open more than a day", () => {
      expect(lineOf("Mo-Fr 00:00-24:00", WED_15_00, "en-US")).toBe("Open until Sat 12 am");
      expect(lineOf("Mo-Fr 00:00-24:00", WED_15_00, "en-GB", "place")).toBe("Open now · closes Sat 00:00");
      expect(lineOf("Mo-Fr 00:00-24:00", "2026-10-09T14:00:00Z", "en-US")).toBe("Open until 12 am");
    });

    it("leaves the weekday out when the place opens within a day", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_23_30, "en-US")).not.toMatch(/Wed|Thu/);
    });

    it("says 24 hours for a place with no closing time", () => {
      expect(lineOf("24/7", WED_15_00)).toBe("Open 24 hours");
      expect(lineOf("24/7", WED_15_00, "pt-PT")).toBe("Open 24 hours");
    });

    it("says Closed for a place that does not open again, or not for a week", () => {
      expect(lineOf("off", WED_15_00)).toBe("Closed");
      expect(lineOf("Apr-Sep Mo-Su 11:00-23:00", WED_15_00)).toBe("Closed");
      expect(lineOf("Apr-Sep Mo-Su 11:00-23:00", WED_15_00, "pt-PT")).toBe("Closed");
    });

    it("says 24 hours for a place nothing closes this week", () => {
      expect(lineOf("24/7; Dec 25 off", WED_15_00)).toBe("Open 24 hours");
    });

    it("says the hours are not listed", () => {
      expect(lineOf(undefined, WED_15_00)).toBe("Hours not listed");
      expect(lineOf("  ", WED_15_00)).toBe("Hours not listed");
    });

    it("shows the raw text of hours it cannot read", () => {
      expect(lineOf("16:00 as 23:00", WED_15_00)).toBe("16:00 as 23:00");
    });
  });

  describe("place", () => {
    it("says Open now, and when it closes", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "en-US", "place")).toBe("Open now · closes 11 pm");
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "pt-PT", "place")).toBe("Open now · closes 23:00");
    });

    it("reads like the card for every other state", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_23_30, "en-US", "place")).toBe("Closed · opens 11 am");
      expect(lineOf("Mo-Fr 09:00-17:00", "2026-10-09T17:00:00Z", "en-US", "place")).toBe("Closed · opens Mon 9 am");
      expect(lineOf("24/7", WED_15_00, "en-US", "place")).toBe("Open 24 hours");
      expect(lineOf("off", WED_15_00, "en-US", "place")).toBe("Closed");
      expect(lineOf(undefined, WED_15_00, "en-US", "place")).toBe("Hours not listed");
      expect(lineOf("16:00 as 23:00", WED_15_00, "en-US", "place")).toBe("16:00 as 23:00");
    });

    it("joins with a comma inside the desktop's line, which the dots already join (DeskPlace.dc.html)", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "en-US", "placeInline")).toBe("Open now, closes 11 pm");
      expect(lineOf("Mo-Su 11:00-23:00", WED_23_30, "en-US", "placeInline")).toBe("Closed, opens 11 am");
      expect(lineOf("24/7", WED_15_00, "en-US", "placeInline")).toBe("Open 24 hours");
      expect(lineOf(undefined, WED_15_00, "en-US", "placeInline")).toBe("Hours not listed");
    });

    it("takes its joiners from the copy module", () => {
      expect(copy.common.joiner).toBe(" · ");
      expect(copy.hours.inlineJoiner).toBe(", ");
      expect(copy.hours.openNowCloses("5 pm")).toBe(`Open now${copy.common.joiner}closes 5 pm`);
      expect(copy.hours.openNowClosesInline("5 pm")).toBe(`Open now${copy.hours.inlineJoiner}closes 5 pm`);
    });
  });

  describe("times", () => {
    it("shows minutes only when they are not :00", () => {
      expect(lineOf("Mo-Su 10:30-22:30", WED_15_00, "en-US")).toBe("Open until 10:30 pm");
      expect(lineOf("Mo-Su 10:30-22:30", WED_15_00, "pt-PT")).toBe("Open until 22:30");
      expect(lineOf("Mo-Su 10:30-22:05", WED_15_00, "en-US")).toBe("Open until 10:05 pm");
    });

    it("writes am and pm in lower case, with 12 for noon and midnight", () => {
      expect(lineOf("Mo-Su 08:00-12:00", "2026-10-07T07:30:00Z", "en-US")).toBe("Open until 12 pm");
      expect(lineOf("Mo-Su 09:30-24:00", WED_15_00, "en-US")).toBe("Open until 12 am");
      expect(lineOf("Mo-Su 09:30-24:00", WED_15_00, "pt-PT")).toBe("Open until 00:00");
      expect(lineOf("Mo-Su 07:00-09:00", "2026-10-07T06:30:00Z", "en-US")).toBe("Open until 9 am");
      expect(lineOf("Mo-Su 07:00-09:00", "2026-10-06T23:30:00Z", "en-US")).toBe("Closed · opens 7 am");
      expect(lineOf("Mo-Su 07:00-09:00", "2026-10-06T23:30:00Z", "pt-PT")).toBe("Closed · opens 07:00");
    });

    it.each([
      ["en-US", "Open until 11 pm"],
      ["en-AU", "Open until 11 pm"],
      ["en-GB", "Open until 23:00"],
      ["de-DE", "Open until 23:00"],
      ["ja-JP", "Open until 23:00"],
      ["pt-BR", "Open until 23:00"],
      ["en-US-u-hc-h23", "Open until 23:00"],
      ["pt-PT-u-hc-h12", "Open until 11 pm"],
    ])("follows the %s clock", (locale, line) => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, locale)).toBe(line);
    });

    it("does not throw on a locale it does not know", () => {
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "not a locale!")).toBe("Open until 11 pm");
      expect(lineOf("Mo-Su 11:00-23:00", WED_15_00, "")).toBe("Open until 11 pm");
    });

    it("formats the wall-clock fields, whatever the runtime's zone", () => {
      const state: OpenState = { kind: "open", closesAt: new Date(2026, 9, 7, 23, 0) };
      expect(openLine(state, "en-US", "card")).toBe("Open until 11 pm");
    });
  });

  describe("copy", () => {
    it("takes every line from the copy module", () => {
      expect(copy.hours.openUntil("5 pm")).toBe("Open until 5 pm");
      expect(copy.hours.openNowCloses("5 pm")).toBe("Open now · closes 5 pm");
      expect(copy.hours.closedOpens("Tue 5 pm")).toBe("Closed · opens Tue 5 pm");
      expect(copy.hours.open24).toBe("Open 24 hours");
      expect(copy.hours.notListed).toBe("Hours not listed");
      expect(copy.hours.closed).toBe("Closed");
    });
  });
});

describe("a viewer whose clock skipped the place's time", () => {
  // The place's clock reading is built as a local Date. When the viewer's own zone skipped that
  // reading (clocks went forward), the Date lands an hour later, so the result would be an hour
  // off. Better to show the hours as written for that evaluation.
  const ROME = "Europe/Rome"; // 2027-03-28 02:00 -> 03:00 local
  const LISBON = "Europe/Lisbon"; // 2027-03-28 01:00 -> 02:00 local

  it("gives the hours as written when the place's current time does not exist for the viewer", () => {
    // Funchal reads 02:30 (summer time began there at 01:00Z): it exists there, not in Rome.
    const hours = "Mo-Su 02:00-03:00";
    const now = "2027-03-28T01:30:00Z";
    expect(stateOf(hours, now)).toEqual({ kind: "open", closesAt: new Date(2027, 2, 28, 3, 0), closingSoon: true });

    vi.stubEnv("TZ", ROME);
    expect(stateOf(hours, now)).toEqual({ kind: "unparsed", raw: hours });
  });

  it("does the same in Lisbon, for a place whose clock reads 01:30", () => {
    // Tokyo reads 01:30 on 28 March at 16:30Z the day before.
    const hours = "Mo-Su 00:00-04:00";
    const now = "2027-03-27T16:30:00Z";
    expect(stateOf(hours, now, TOKYO)).toEqual({ kind: "open", closesAt: new Date(2027, 2, 28, 4, 0) });

    vi.stubEnv("TZ", LISBON);
    expect(stateOf(hours, now, TOKYO)).toEqual({ kind: "unparsed", raw: hours });
  });

  it("gives the hours as written when a closing time falls in the skipped hour", () => {
    // Funchal 00:30 on 28 March, open until 02:30; Rome has no 02:30 that morning.
    const hours = "Mo-Su 00:00-02:30";
    const now = "2027-03-28T00:30:00Z";
    expect(stateOf(hours, now)).toEqual({ kind: "open", closesAt: new Date(2027, 2, 28, 2, 30) });

    vi.stubEnv("TZ", ROME);
    expect(stateOf(hours, now)).toEqual({ kind: "unparsed", raw: hours });
  });

  it("gives the hours as written when an opening time falls in the skipped hour", () => {
    // Funchal 23:00 the night before, opens at 02:30.
    const hours = "Mo-Su 02:30-04:00";
    const now = "2027-03-27T23:00:00Z";
    expect(stateOf(hours, now)).toEqual({ kind: "closed", opensAt: new Date(2027, 2, 28, 2, 30) });

    vi.stubEnv("TZ", ROME);
    expect(stateOf(hours, now)).toEqual({ kind: "unparsed", raw: hours });
  });

  it("reads ordinary times as usual in those zones, on that day and any other", () => {
    vi.stubEnv("TZ", ROME);
    expect(lineOf("Mo-Su 11:00-23:00", "2027-03-28T11:00:00Z")).toBe("Open until 11 pm");
    expect(lineOf("Mo-Su 11:00-23:00", "2027-03-27T11:00:00Z")).toBe("Open until 11 pm");
    expect(lineOf("Mo-Su 11:00-23:00", WED_23_30)).toBe("Closed · opens 11 am");
    vi.stubEnv("TZ", LISBON);
    expect(lineOf("Mo-Su 11:00-23:00", "2027-03-28T11:00:00Z")).toBe("Open until 11 pm");
  });

  it("is fine on the day the clocks go back, when an hour happens twice", () => {
    vi.stubEnv("TZ", ROME);
    // 2026-10-25: Rome goes 03:00 -> 02:00, so its 02:00-03:00 happens twice. Funchal reads 02:30 at 02:30Z.
    expect(stateOf("Mo-Su 00:00-03:00", "2026-10-25T02:30:00Z")).toEqual({
      kind: "open",
      closesAt: new Date(2026, 9, 25, 3, 0),
      closingSoon: true,
    });
  });
});

describe("the parsed hours are remembered", () => {
  const built = () => vi.mocked(OpeningHours).mock.calls.length;
  /**
   * `n` different valid hours strings (up to 11,440), none used elsewhere in this file: a day or
   * days, an opening time, and the closing time `end`. Two sets with different `end`s share none.
   */
  const distinct = (n: number, end = "23:57") =>
    Array.from({ length: n }, (_, i) => {
      const start = i % 1430;
      const time = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
      return `${["Mo-Fr", "Sa-Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][Math.floor(i / 1430)]} ${time}-${end}`;
    });
  const NOW = at(WED_15_00);

  it("parses once for the same hours and country, however often it is asked", () => {
    const before = built();
    const place = { ...FUNCHAL, openingHours: "Mo-Su 06:07-08:09" };
    const first = openState(place, NOW);
    for (let i = 0; i < 5; i++) expect(openState(place, new Date(NOW.getTime() + i * 60_000))).toBeDefined();
    expect(built() - before).toBe(1);
    expect(first.kind).toBe("closed");
  });

  it("parses the same hours again for another country, since the holidays differ", () => {
    const before = built();
    const hours = "Mo-Su 06:08-08:10; PH off";
    openState({ ...FUNCHAL, openingHours: hours }, NOW);
    openState({ ...FUNCHAL, country: "ES", openingHours: hours }, NOW);
    openState({ ...FUNCHAL, openingHours: hours }, NOW);
    openState({ ...FUNCHAL, country: "ES", openingHours: hours }, NOW);
    expect(built() - before).toBe(2);
  });

  it("remembers hours that do not parse or that the parser had to guess at", () => {
    const before = built();
    for (const hours of ["no such hours at all", "16:00 as 23:07"]) {
      const place = { ...FUNCHAL, openingHours: hours };
      expect(openState(place, NOW).kind).toBe("unparsed");
      expect(openState(place, NOW).kind).toBe("unparsed");
    }
    expect(built() - before).toBe(2);
  });

  it("does not parse hours it will not read, or no hours", () => {
    const before = built();
    openState({ ...FUNCHAL, openingHours: undefined }, NOW);
    openState({ ...FUNCHAL, openingHours: "  " }, NOW);
    openState({ ...FUNCHAL, openingHours: "sunrise-sunset" }, NOW);
    openState({ ...FUNCHAL, openingHours: "x".repeat(300) }, NOW);
    expect(built() - before).toBe(0);
  });

  it("gives the parser the country's holidays and nothing else", () => {
    openState({ ...FUNCHAL, openingHours: "Mo-Su 06:09-08:11; PH off" }, NOW);
    expect(OpeningHours).toHaveBeenLastCalledWith("Mo-Su 06:09-08:11; PH off", {
      address: { country_code: "pt", state: "" },
    });
    openState({ lat: FUNCHAL.lat, lon: FUNCHAL.lon, openingHours: "Mo-Su 06:10-08:12" }, NOW);
    expect(OpeningHours).toHaveBeenLastCalledWith("Mo-Su 06:10-08:12", undefined);
  });

  it("remembers the hours of every place in a dense city, so Open now parses nobody twice", () => {
    // Open now asks about every place near the point: thousands, in a big city. A parse keeps about
    // 24 KB, so the memory is held to 3,000 (about 70 MB) for a phone's sake.
    expect(PARSE_CACHE_LIMIT).toBe(3000);
    const before = built();
    const city = distinct(2_500, "23:56");
    const pass = () => city.forEach((hours) => openState({ ...FUNCHAL, openingHours: hours }, NOW));
    pass();
    expect(built() - before).toBe(2_500);
    pass();
    expect(built() - before).toBe(2_500);
  });

  it("keeps a bounded number of them, dropping the one used longest ago", () => {
    const before = built();
    const all = distinct(PARSE_CACHE_LIMIT);
    const parse = (hours: string) => openState({ ...FUNCHAL, openingHours: hours }, NOW);

    all.forEach(parse); // fills the memory with exactly these
    expect(built() - before).toBe(PARSE_CACHE_LIMIT);

    parse(all[0] as string); // used again: no new parse, and now the newest
    expect(built() - before).toBe(PARSE_CACHE_LIMIT);

    parse("Mo-Su 05:55-23:58"); // one more: the oldest (all[1]) goes, all[0] stays
    expect(built() - before).toBe(PARSE_CACHE_LIMIT + 1);

    parse(all[0] as string);
    expect(built() - before).toBe(PARSE_CACHE_LIMIT + 1);
    parse(all[1] as string);
    expect(built() - before).toBe(PARSE_CACHE_LIMIT + 2);
  });
});

describe("the parser's own noise", () => {
  // The parser writes to the console when it meets a country it has no holidays for, and for
  // some of its own bugs, as well as throwing. A card must not litter the console.
  const GB = { lat: 51.5074, lon: -0.1278, country: "GB" };
  const quiet = () => ({
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  });

  it("writes nothing to the console for a holiday rule in a country with no usable holiday data", () => {
    const spies = quiet();
    const hours = "Mo-Su 11:00-23:00; PH off";
    // Great Britain has holidays per nation only, and a place does not say which.
    expect(stateOf(hours, WED_15_00, GB)).toEqual({ kind: "unparsed", raw: hours });
    expect(stateOf("Mo-Su 11:00-23:00; SH off", WED_15_00, GB).kind).toBe("unparsed");
    expect(stateOf(hours, WED_15_00, { ...FUNCHAL, country: "ZZ" }).kind).toBe("unparsed");
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("writes nothing to the console for the odd strings, either", () => {
    const spies = quiet();
    const odd = ["PH off", "hello world", "Mo-Su 25:00-26:00", "; ; ;", "Dec 25 off", "Mo-Su 11:00-23:00 ".repeat(14)];
    for (const hours of odd) {
      stateOf(hours, WED_15_00);
      stateOf(hours, WED_15_00, GB);
    }
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("puts the console back as it found it", () => {
    const error = console.error;
    const warn = console.warn;
    stateOf("Mo-Su 11:00-23:00; PH off", WED_15_00, GB);
    expect(console.error).toBe(error);
    expect(console.warn).toBe(warn);
  });
});

describe("weekTable", () => {
  const tableOf = (openingHours: string | undefined, locale = "en-US", iso = WED_15_00, where: Where = FUNCHAL) =>
    weekTable({ ...where, openingHours }, at(iso), locale);
  /** Each day's line as the page shows it: the ranges, or nothing for a day it is closed. */
  const lines = (table: ReturnType<typeof weekTable>) => table?.map(({ day, ranges }) => `${day} ${ranges.join(", ")}`.trim());

  it("lists the coming seven days, Monday first, with each day's hours", () => {
    // Wed 7 Oct 2026 in Funchal: the week is Wed to Tue, listed Monday first.
    expect(lines(tableOf("Mo-Fr 09:30-17:30; Sa-Su 09:30-13:30"))).toEqual([
      "Mon 9:30 am to 5:30 pm",
      "Tue 9:30 am to 5:30 pm",
      "Wed 9:30 am to 5:30 pm",
      "Thu 9:30 am to 5:30 pm",
      "Fri 9:30 am to 5:30 pm",
      "Sat 9:30 am to 1:30 pm",
      "Sun 9:30 am to 1:30 pm",
    ]);
  });

  it("names the days from the copy module", () => {
    expect(tableOf("24/7")?.map(({ day }) => day)).toEqual([...copy.hours.weekdaysShort]);
  });

  it("writes the times on the locale's clock", () => {
    expect(tableOf("Mo-Su 09:30-17:00", "pt-PT")?.[0]).toEqual({ day: "Mon", ranges: ["09:30 to 17:00"] });
    expect(tableOf("Mo-Su 12:00-13:00", "en-US")?.[0]).toEqual({ day: "Mon", ranges: ["12 pm to 1 pm"] });
  });

  it("lists each opening of a day, and no hours for a day it is closed", () => {
    const table = tableOf("Tu-Sa 09:00-12:00,14:00-18:00");
    expect(table?.[0]).toEqual({ day: "Mon", ranges: [] });
    expect(table?.[1]).toEqual({ day: "Tue", ranges: ["9 am to 12 pm", "2 pm to 6 pm"] });
    expect(table?.[6]).toEqual({ day: "Sun", ranges: [] });
  });

  it("gives a day open round the clock as open 24 hours", () => {
    expect(tableOf("24/7")?.every(({ ranges }) => ranges.length === 1 && ranges[0] === copy.hours.open24)).toBe(true);
    const weekdays = tableOf("Mo-Fr 00:00-24:00");
    expect(weekdays?.[4]).toEqual({ day: "Fri", ranges: [copy.hours.open24] });
    expect(weekdays?.[5]).toEqual({ day: "Sat", ranges: [] });
  });

  it("puts a night that runs past midnight on the day it starts", () => {
    expect(lines(tableOf("Mo-Sa 11:00-24:00, Fr-Sa 11:00-02:00"))).toEqual([
      "Mon 11 am to midnight",
      "Tue 11 am to midnight",
      "Wed 11 am to midnight",
      "Thu 11 am to midnight",
      "Fri 11 am to 2 am",
      "Sat 11 am to 2 am",
      // Saturday's night runs into Sunday, which does not open.
      "Sun",
    ]);
  });

  it("keeps an opening that starts at midnight unless the night before ran into it", () => {
    // Saturday is open all day, which carries nothing over: Sunday opens at midnight.
    const sundays = tableOf("Mo-Sa 00:00-24:00; Su 00:00-20:00");
    expect(sundays?.[6]).toEqual({ day: "Sun", ranges: ["12 am to 8 pm"] });
    expect(sundays?.[5]).toEqual({ day: "Sat", ranges: [copy.hours.open24] });

    const saturdays = tableOf("Mo-Fr 00:00-24:00; Sa 00:00-14:00");
    expect(saturdays?.[5]).toEqual({ day: "Sat", ranges: ["12 am to 2 pm"] });
    expect(saturdays?.[6]).toEqual({ day: "Sun", ranges: [] });

    // Closed for two hours on Wednesday, open round the clock otherwise.
    const wednesday = tableOf("24/7; We 10:00-12:00 off");
    expect(wednesday?.[2]).toEqual({ day: "Wed", ranges: ["12 am to 10 am", `12 pm to ${copy.hours.midnight}`] });
    expect(wednesday?.[1]).toEqual({ day: "Tue", ranges: [copy.hours.open24] });
    expect(wednesday?.[3]).toEqual({ day: "Thu", ranges: [copy.hours.open24] });
  });

  it("carries a night over into the next morning only, and lets a day that opens at midnight and runs into the afternoon say so", () => {
    // Closing before noon: a late night, on the day it starts.
    const late = tableOf("Mo-Su 18:00-02:00");
    expect(late?.every(({ ranges }) => ranges.length === 1 && ranges[0] === "6 pm to 2 am")).toBe(true);
    // Closing in the afternoon: two openings, each on its own day, and neither day closed.
    const evening = tableOf("Fr 18:00-24:00; Sa 00:00-14:00");
    expect(evening?.[4]).toEqual({ day: "Fri", ranges: [`6 pm to ${copy.hours.midnight}`] });
    expect(evening?.[5]).toEqual({ day: "Sat", ranges: ["12 am to 2 pm"] });
    const night = tableOf("Fr 21:00-24:00; Sa 00:00-17:00");
    expect(night?.[4]).toEqual({ day: "Fri", ranges: [`9 pm to ${copy.hours.midnight}`] });
    expect(night?.[5]).toEqual({ day: "Sat", ranges: ["12 am to 5 pm"] });
    // A night that runs to noon starts the next day's own opening.
    const noon = tableOf("Su-Th 16:00-12:00");
    expect(noon?.[0]).toEqual({ day: "Mon", ranges: [`12 am to 12 pm`, `4 pm to ${copy.hours.midnight}`] });
    expect(noon?.[4]).toEqual({ day: "Fri", ranges: ["12 am to 12 pm"] });
    expect(noon?.[5]).toEqual({ day: "Sat", ranges: [] });
  });

  it("shows the regular week, leaving out the public holidays in it", () => {
    // Monday 30 November 2026 in Funchal; Tuesday 1 December is a public holiday in Portugal.
    const hours = "Mo-Fr 09:00-17:00; PH off";
    const monday = "2026-11-30T12:00:00Z";
    const table = tableOf(hours, "en-US", monday);
    expect(table?.[1]).toEqual({ day: "Tue", ranges: ["9 am to 5 pm"] });
    expect(table?.slice(0, 5).every(({ ranges }) => ranges[0] === "9 am to 5 pm")).toBe(true);
    expect(table?.slice(5).every(({ ranges }) => ranges.length === 0)).toBe(true);
    // Whether it is open now still keeps the holiday.
    expect(stateOf(hours, "2026-12-01T12:00:00Z").kind).toBe("closed");
    // A week with no holiday in it is the week ahead, dated closures and all.
    expect(tableOf("Mo-Fr 09:00-17:00; PH off; Oct 09 off")?.[4]).toEqual({ day: "Fri", ranges: [] });
  });

  it("says when it closes at midnight", () => {
    expect(tableOf("Mo-Su 09:30-24:00")?.[0]).toEqual({ day: "Mon", ranges: [`9:30 am to ${copy.hours.midnight}`] });
  });

  it("follows the place's calendar, not the runtime's", () => {
    // 16:00Z on Wednesday 7 Oct is 01:00 on Thursday 8 in Tokyo: its week runs Thursday to
    // Wednesday 14, so the closure on the 14th is this week's Wednesday. In UTC it would be next week's.
    const table = tableOf("Mo-Su 10:00-20:00; Oct 14 off", "en-US", "2026-10-07T16:00:00Z", TOKYO);
    expect(table?.[2]).toEqual({ day: "Wed", ranges: [] });
    expect(table?.[3]).toEqual({ day: "Thu", ranges: ["10 am to 8 pm"] });
  });

  it("lists every day as closed for hours that say the place is shut", () => {
    expect(tableOf("off")?.every(({ ranges }) => ranges.length === 0)).toBe(true);
  });

  it("is null for hours that are missing or that the app cannot read", () => {
    expect(tableOf(undefined)).toBeNull();
    expect(tableOf("  ")).toBeNull();
    expect(tableOf("no such hours at all")).toBeNull();
    expect(tableOf("sunrise-sunset")).toBeNull();
    expect(tableOf("Sa 09:00+")).toBeNull();
    expect(tableOf("x".repeat(300))).toBeNull();
  });

  it("is null when a week of the table would leave out what the hours say", () => {
    // A comment on a rule.
    expect(tableOf('Mo-Fr 09:00-17:00 "by appointment"')).toBeNull();
    // A season that is over for now: a week of "closed" would hide when it opens again.
    expect(tableOf("Apr-Sep Mo-Su 11:00-23:00")).toBeNull();
  });

  it("is null rather than an hour off when the runtime's clock skips one of the times", () => {
    // 2027-03-28: Rome's clocks go 02:00 -> 03:00, so a 02:30 that Funchal has does not exist there.
    const hours = "Mo-Su 02:30-04:00";
    expect(tableOf(hours, "en-US", "2027-03-25T12:00:00Z")?.[6]).toEqual({ day: "Sun", ranges: ["2:30 am to 4 am"] });
    vi.stubEnv("TZ", "Europe/Rome");
    expect(tableOf(hours, "en-US", "2027-03-25T12:00:00Z")).toBeNull();
  });

  it("is null rather than wrong when a closing time falls in the hour the runtime's clock skips", () => {
    // Viewed on Sunday 21 March 2027: Saturday the 27th's night ends at 02:00 on the 28th, the
    // morning London's clocks go forward, where a 02:00 cannot be told from a moved 01:00.
    const hours = "Mo-Su 11:00-02:00";
    const sunday = "2027-03-21T12:00:00Z";
    expect(tableOf(hours, "en-US", sunday)?.[5]).toEqual({ day: "Sat", ranges: ["11 am to 2 am"] });
    vi.stubEnv("TZ", "Europe/London");
    expect(tableOf(hours, "en-US", sunday)).toBeNull();
  });

  it("never throws, and writes nothing to the console", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const hours of ["PH off", "Mo-Su 25:00-26:00", "; ; ;", "Mo-Su 11:00-23:00; PH off"]) {
      expect(() => tableOf(hours, "en-US", WED_15_00, { lat: 51.5074, lon: -0.1278, country: "GB" })).not.toThrow();
    }
    expect(() => tableOf("Mo-Su 11:00-23:00", "not a locale")).not.toThrow();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads every hours string of the Funchal fixtures that openState reads", () => {
    const places = (raw as NostrEvent[]).flatMap((event) => {
      const place = parsePlace(event, config.headerCoordinate);
      return place === null ? [] : [place];
    });
    for (const place of places) {
      const state = openState(place, at(WED_15_00));
      const table = weekTable(place, at(WED_15_00), "en-US");
      if (state.kind === "open" || state.kind === "closed") {
        expect(table, place.openingHours).toHaveLength(7);
      } else {
        expect(table).toBeNull();
      }
    }
  });

  it("takes the words from the copy module", () => {
    expect(copy.hours.range("9 am", "5 pm")).toBe("9 am to 5 pm");
    expect(copy.hours.midnight).toBe("midnight");
  });
});
