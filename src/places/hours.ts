import tzLookup from "@photostructure/tz-lookup";
import OpeningHours from "opening_hours";

import { copy } from "../copy/en.ts";
import type { Place } from "./place.ts";

/**
 * Whether a place is open now, from its OpenStreetMap `opening-hours` text.
 *
 * Every Date in an OpenState is a wall-clock Date: it carries the place's clock reading in its
 * local fields (`getHours()`, `getDay()` ...) and is not the real instant. A Date is built that
 * way because `opening_hours` reads and returns Dates in the runtime's own time zone, and the
 * runtime is rarely in the place's zone. Format a closesAt or opensAt from its local fields, as
 * `openLine` does, and never with a `timeZone` option or `getUTC*`; never compare it to a real
 * instant.
 */
export type OpenState =
  /**
   * `closesAt` is undefined when nothing ends the opening this week: open 24/7, say.
   * `closesAfterADay` is set, to true and only then, when it closes more than 24 hours after
   * `now`, so the line can name the weekday.
   */
  | { kind: "open"; closesAt?: Date; closesAfterADay?: boolean }
  /**
   * `opensAt` is undefined when it does not open again this week (a seasonal place, or one that
   * is shut for good). `opensAfterADay` is set, to true and only then, when it opens more than
   * 24 hours after `now`, so the line can name the weekday.
   */
  | { kind: "closed"; opensAt?: Date; opensAfterADay?: boolean }
  /** The place has no hours. */
  | { kind: "unknown" }
  /** There are hours the app cannot read or cannot judge; show `raw` as written. */
  | { kind: "unparsed"; raw: string };

type HoursPlace = Pick<Place, "openingHours" | "lat" | "lon" | "country">;

/**
 * The parser is lenient: it repairs what it can ("Mon-Fri 9 to 5", "16:00 as 23:00") and says so
 * in a warning. A repair is a guess, and the app does not state a guess as a fact ("Open until
 * 5 pm"), so hours with one of these warnings are shown as written.
 */
const GUESSED: ReadonlySet<string> = new Set([
  "word_error_correction",
  "ambiguous_word",
  "ambiguous_single_digit_hour",
  "nothing_useful",
]);

/**
 * Sunrise, sunset, dawn and dusk. The parser works these out in the runtime's time zone, so for a
 * place in another zone they come out hours wrong. Shown as written until they can be worked out
 * in the place's zone.
 */
const SOLAR = /\b(?:sunrise|sunset|dawn|dusk)\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * OpenStreetMap limits a tag value to 255 characters, so anything longer did not come from it.
 * The parser can take tens of seconds on a long, odd string, and the text comes from a relay.
 */
const MAX_HOURS_LENGTH = 255;

/**
 * How far ahead to look for the next change, in days. Seven covers any weekly schedule, and a
 * weekday name is unambiguous within it. The parser's own default search can run for tens of
 * seconds on odd hours such as "PH off" before it gives up.
 */
const LOOKAHEAD_DAYS = 7;

/** Hours that say a place is shut for good, rather than listing only some of its closures. */
const SHUT = /^\s*(?:off|closed)\s*$/i;

/** The IANA time zone at a coordinate, such as `Atlantic/Madeira`. Throws for an invalid coordinate. */
export function timeZoneOf(lat: number, lon: number): string {
  return tzLookup(lat, lon);
}

const clockReaders = new Map<string, Intl.DateTimeFormat>();

/** A wall-clock Date: the reading of the clock in `timeZone` at `instant`, as local fields. */
function wallClock(instant: Date, timeZone: string): Date {
  let reader = clockReaders.get(timeZone);
  if (reader === undefined) {
    reader = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    clockReaders.set(timeZone, reader);
  }
  const parts = reader.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isFinite(value)) throw new RangeError(`No ${type} in the clock reading for ${timeZone}`);
    return value;
  };
  // % 24 guards engines that write midnight as 24.
  return new Date(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
}

/** Milliseconds on the wall clock, so that the difference of two wall Dates ignores the runtime's DST. */
function wallMs(date: Date): number {
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

/** `date` plus whole days, on the wall clock (it keeps the time of day across the runtime's DST). */
function addDays(date: Date, days: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

/**
 * The parser needs the country to know the public holidays. It also takes the place's
 * coordinates, but only to work out sunrise and sunset, which are not evaluated (see SOLAR).
 */
function holidayContext(place: HoursPlace) {
  if (place.country === undefined) return undefined;
  return { lat: place.lat, lon: place.lon, address: { country_code: place.country.toLowerCase(), state: "" } };
}

function evaluate(raw: string, place: HoursPlace, now: Date): OpenState {
  const unparsed: OpenState = { kind: "unparsed", raw };
  if (raw.length > MAX_HOURS_LENGTH || SOLAR.test(raw)) return unparsed;

  const hours = new OpeningHours(raw, holidayContext(place));
  if (hours.getStructuredWarnings().some((warning) => GUESSED.has(warning.type))) return unparsed;

  const here = wallClock(now, timeZoneOf(place.lat, place.lon));
  // Unknown covers hours with no closing time ("Sa 09:00+") and rules marked unknown.
  if (hours.getUnknown(here)) return unparsed;

  const next = hours.getNextChange(here, addDays(here, LOOKAHEAD_DAYS));
  const afterADay = next !== undefined && wallMs(next) - wallMs(here) > DAY_MS;
  if (hours.getState(here)) {
    // No change within a week of an open place: for a diner, open all the time.
    if (next === undefined) return { kind: "open" };
    return afterADay ? { kind: "open", closesAt: next, closesAfterADay: true } : { kind: "open", closesAt: next };
  }
  if (next !== undefined) {
    return afterADay ? { kind: "closed", opensAt: next, opensAfterADay: true } : { kind: "closed", opensAt: next };
  }
  // Closed, and not opening this week. Say so without a weekday that would mislead, but only
  // when the hours do open some time in the year, or say the place is shut. Hours that list
  // closures alone ("PH off"), or have run out ("2025 Mo-Su 10:00-12:00"), are shown as written.
  const reopens = hours.getNextChange(here, addDays(here, 366)) !== undefined;
  return reopens || SHUT.test(raw) ? { kind: "closed" } : unparsed;
}

/**
 * Whether the place is open at `now`, a real instant, judged on the clock and calendar of the
 * place's own time zone (found from its coordinates) and its country's public holidays.
 * Never throws: whatever the parser or the zone lookup cannot handle gives `unparsed`.
 */
export function openState(place: HoursPlace, now: Date): OpenState {
  const raw = place.openingHours;
  if (raw === undefined || raw.trim() === "") return { kind: "unknown" };
  try {
    return evaluate(raw, place, now);
  } catch {
    return { kind: "unparsed", raw };
  }
}

const FALLBACK_LOCALE = "en-US";

interface LocaleClock {
  twelveHour: boolean;
  /** The locale's short weekday: "Tue". */
  weekday: Intl.DateTimeFormat;
}

const localeClocks = new Map<string, LocaleClock>();

function buildClock(locale: string): LocaleClock {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return {
    twelveHour: cycle === "h11" || cycle === "h12",
    weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
  };
}

function localeClock(locale: string): LocaleClock {
  let clock = localeClocks.get(locale);
  if (clock === undefined) {
    try {
      clock = buildClock(locale);
    } catch {
      // A malformed locale tag reads the clock the way English does.
      clock = buildClock(FALLBACK_LOCALE);
    }
    localeClocks.set(locale, clock);
  }
  return clock;
}

const twoDigits = (n: number) => String(n).padStart(2, "0");

/**
 * "11 pm", "10:30 pm" or "23:00" from the wall-clock fields of `at`, with the weekday before it
 * when asked: "Tue 11 pm".
 */
function formatTime(at: Date, clock: LocaleClock, withWeekday: boolean): string {
  const hours = at.getHours();
  const minutes = at.getMinutes();
  let time: string;
  if (clock.twelveHour) {
    const hour = hours % 12 === 0 ? 12 : hours % 12;
    const period = hours < 12 ? copy.hours.am : copy.hours.pm;
    time = minutes === 0 ? `${hour} ${period}` : `${hour}:${twoDigits(minutes)} ${period}`;
  } else {
    time = `${twoDigits(hours)}:${twoDigits(minutes)}`;
  }
  return withWeekday ? `${clock.weekday.format(at)} ${time}` : time;
}

/**
 * The line a card or the place page shows for a state: "Open until 11 pm", "Closed · opens 7 am",
 * "Hours not listed", or the hours as written when they cannot be read. Times follow the locale's
 * 12- or 24-hour clock. `where` only matters for an open place: the page says "Open now · closes 11 pm".
 */
export function openLine(state: OpenState, locale: string, where: "card" | "place"): string {
  switch (state.kind) {
    case "unknown":
      return copy.hours.notListed;
    case "unparsed":
      return state.raw;
    case "open": {
      if (state.closesAt === undefined) return copy.hours.open24;
      const time = formatTime(state.closesAt, localeClock(locale), state.closesAfterADay === true);
      return where === "card" ? copy.hours.openUntil(time) : copy.hours.openNowCloses(time);
    }
    case "closed": {
      if (state.opensAt === undefined) return copy.hours.closed;
      return copy.hours.closedOpens(formatTime(state.opensAt, localeClock(locale), state.opensAfterADay === true));
    }
  }
}
