import tzLookup from "@photostructure/tz-lookup";
import OpeningHours, { type nominatim_object } from "opening_hours";

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

/**
 * A wall-clock Date: the reading of the clock in `timeZone` at `instant`, as local fields. When
 * the runtime's own zone skipped that reading (its clocks went forward over it), `new Date`
 * quietly moves it an hour on, and the answer would be an hour off; that gives undefined.
 */
function wallClock(instant: Date, timeZone: string): Date | undefined {
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
  const year = read("year");
  const month = read("month") - 1;
  const day = read("day");
  const hour = read("hour") % 24; // % 24 guards engines that write midnight as 24
  const minute = read("minute");
  const second = read("second");
  const wall = new Date(year, month, day, hour, minute, second);
  const kept =
    wall.getFullYear() === year &&
    wall.getMonth() === month &&
    wall.getDate() === day &&
    wall.getHours() === hour &&
    wall.getMinutes() === minute &&
    wall.getSeconds() === second;
  return kept ? wall : undefined;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether a Date the parser handed back may have been moved by the runtime's zone: it falls in
 * the hour after the runtime's clocks went forward, where a skipped reading ends up. The parser
 * builds its Dates from local fields and there is no telling a moved 02:30 from a true 03:30, so
 * both count.
 */
function maybeMoved(date: Date): boolean {
  return new Date(date.getTime() - HOUR_MS).getTimezoneOffset() > date.getTimezoneOffset();
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
 * What the parser needs to know the public holidays: the country. (It also takes the place's
 * coordinates, but only to work out sunrise and sunset, which are not evaluated here, and its
 * type declarations wrongly ask for numbers where it reads strings. They are left out.)
 */
function holidayContext(country: string | undefined): nominatim_object | undefined {
  if (country === undefined) return undefined;
  return { address: { country_code: country, state: "" } } as nominatim_object;
}

/**
 * How many parsed hours to remember. A list shows far fewer places than this at once, but Open
 * now asks about every place near the point, and a dense city has thousands within the radius:
 * a memory smaller than that is parsed over again on every pass (every minute).
 */
export const PARSE_CACHE_LIMIT = 10_000;

/** Parsed hours by country and text, oldest use first. `null` is hours that cannot be used. */
const parsed = new Map<string, OpeningHours | null>();

/**
 * The parser for these hours in this country, or null when they do not parse or the parser had to
 * guess at them. Parsing is the slow part of a card, so a list that redraws does not repeat it.
 */
function parse(raw: string, country: string | undefined): OpeningHours | null {
  const key = JSON.stringify([country, raw]);
  const known = parsed.get(key);
  if (known !== undefined) {
    parsed.delete(key);
    parsed.set(key, known);
    return known;
  }
  let hours: OpeningHours | null;
  try {
    const candidate = new OpeningHours(raw, holidayContext(country));
    hours = candidate.getStructuredWarnings().some((warning) => GUESSED.has(warning.type)) ? null : candidate;
  } catch {
    hours = null;
  }
  parsed.set(key, hours);
  if (parsed.size > PARSE_CACHE_LIMIT) {
    const oldest = parsed.keys().next().value;
    if (oldest !== undefined) parsed.delete(oldest);
  }
  return hours;
}

/**
 * The parser writes to the console as well as throwing: for a country it has no holidays for, and
 * for some of its own bugs. It does it synchronously, so silence the console around it.
 */
function quietly<T>(run: () => T): T {
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try {
    return run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

function evaluate(raw: string, place: HoursPlace, now: Date): OpenState {
  const unparsed: OpenState = { kind: "unparsed", raw };
  if (raw.length > MAX_HOURS_LENGTH || SOLAR.test(raw)) return unparsed;

  const hours = parse(raw, place.country?.toLowerCase());
  if (hours === null) return unparsed;

  const here = wallClock(now, timeZoneOf(place.lat, place.lon));
  if (here === undefined) return unparsed;
  // Unknown covers hours with no closing time ("Sa 09:00+") and rules marked unknown.
  if (hours.getUnknown(here)) return unparsed;

  const next = hours.getNextChange(here, addDays(here, LOOKAHEAD_DAYS));
  // A change into "unknown" (a comment-only rule, "unknown", an open end) is not an opening or a
  // closing time. Nor is one the runtime's zone may have moved.
  if (next !== undefined && (hours.getUnknown(next) || maybeMoved(next))) return unparsed;

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
    return quietly(() => evaluate(raw, place, now));
  } catch {
    return { kind: "unparsed", raw };
  }
}

const FALLBACK_LOCALE = "en-US";

const twelveHourLocales = new Map<string, boolean>();

/** Whether the locale writes the time on a 12-hour clock ("11 pm") and not a 24-hour one ("23:00"). */
function usesTwelveHour(locale: string): boolean {
  let twelve = twelveHourLocales.get(locale);
  if (twelve === undefined) {
    const cycleOf = (tag: string) => new Intl.DateTimeFormat(tag, { hour: "numeric" }).resolvedOptions().hourCycle;
    let cycle: string | undefined;
    try {
      cycle = cycleOf(locale);
    } catch {
      // A malformed locale tag reads the clock the way English does.
      cycle = cycleOf(FALLBACK_LOCALE);
    }
    twelve = cycle === "h11" || cycle === "h12";
    twelveHourLocales.set(locale, twelve);
  }
  return twelve;
}

const twoDigits = (n: number) => String(n).padStart(2, "0");

/**
 * "11 pm", "10:30 pm" or "23:00" from the wall-clock fields of `at`, with the weekday before it
 * when asked: "Tue 11 pm". Only the 12- or 24-hour choice follows the locale; the words are the
 * copy module's.
 */
function formatTime(at: Date, twelveHour: boolean, withWeekday: boolean): string {
  const hours = at.getHours();
  const minutes = at.getMinutes();
  let time: string;
  if (twelveHour) {
    const hour = hours % 12 === 0 ? 12 : hours % 12;
    const period = hours < 12 ? copy.hours.am : copy.hours.pm;
    time = minutes === 0 ? `${hour} ${period}` : `${hour}:${twoDigits(minutes)} ${period}`;
  } else {
    time = `${twoDigits(hours)}:${twoDigits(minutes)}`;
  }
  // getDay() counts from Sunday, the copy list from Monday.
  const weekday = withWeekday ? copy.hours.weekdaysShort[(at.getDay() + 6) % 7] : undefined;
  return weekday === undefined ? time : `${weekday} ${time}`;
}

/**
 * The line a card or the place page shows for a state: "Open until 11 pm", "Closed · opens 7 am",
 * "Hours not listed", or the hours as written when they cannot be read. The time follows the
 * locale's 12- or 24-hour clock. `where` only matters for an open place: the page says "Open now ·
 * closes 11 pm".
 */
export function openLine(state: OpenState, locale: string, where: "card" | "place"): string {
  switch (state.kind) {
    case "unknown":
      return copy.hours.notListed;
    case "unparsed":
      return state.raw;
    case "open": {
      if (state.closesAt === undefined) return copy.hours.open24;
      const time = formatTime(state.closesAt, usesTwelveHour(locale), state.closesAfterADay === true);
      return where === "card" ? copy.hours.openUntil(time) : copy.hours.openNowCloses(time);
    }
    case "closed": {
      if (state.opensAt === undefined) return copy.hours.closed;
      return copy.hours.closedOpens(formatTime(state.opensAt, usesTwelveHour(locale), state.opensAfterADay === true));
    }
  }
}
