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
 * a memory smaller than that is parsed over again on every pass (every minute). A parsed
 * schedule keeps about 24 KB (measured), so this many are about 70 MB, which a phone can spare;
 * ten thousand would be about 250 MB, which it cannot.
 */
export const PARSE_CACHE_LIMIT = 3000;

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
 * locale's 12- or 24-hour clock. `where` matters for an open place, and on the desktop's place page
 * for a closed one: the page says "Open now · closes 11 pm"; `placeInline`, inside the desktop's
 * line that dots join already, says "Open now, closes 11 pm" and "Closed, opens 7 am".
 */
export function openLine(state: OpenState, locale: string, where: "card" | "place" | "placeInline"): string {
  switch (state.kind) {
    case "unknown":
      return copy.hours.notListed;
    case "unparsed":
      return state.raw;
    case "open": {
      if (state.closesAt === undefined) return copy.hours.open24;
      const time = formatTime(state.closesAt, usesTwelveHour(locale), state.closesAfterADay === true);
      if (where === "card") return copy.hours.openUntil(time);
      return where === "place" ? copy.hours.openNowCloses(time) : copy.hours.openNowClosesInline(time);
    }
    case "closed": {
      if (state.opensAt === undefined) return copy.hours.closed;
      const time = formatTime(state.opensAt, usesTwelveHour(locale), state.opensAfterADay === true);
      return where === "placeInline" ? copy.hours.closedOpensInline(time) : copy.hours.closedOpens(time);
    }
  }
}

/** One day of a place's week: its short name, and each opening in it as words ("9:30 am to 5:30 pm"). None: it is closed. */
export interface WeekDay {
  day: string;
  ranges: string[];
}

/** Hours that name public or school holidays: the week ahead may not be their regular week. */
const NAMES_HOLIDAYS = /\b(?:PH|SH)\b/;

/** A night that runs past midnight is put on the day it starts when it closes before this hour (noon) of the next. */
const NIGHT_ENDS_BEFORE_HOUR = 12;

/** How many weeks ahead to look for a week with no public holiday in it, or near it. */
const REGULAR_WEEK_SEARCH = 8;

/** A day of the table, as worked out: its weekday (Monday 0), its openings, and whether its last runs past midnight. */
interface Row {
  weekday: number;
  ranges: string[];
  carriesOver: boolean;
}

/**
 * The days of the place's regular week, with the parser that read the hours, on the place's
 * calendar: the week ahead, or, for hours that name holidays, the first week from it with no public
 * holiday in it or on either side of it. The table is the regular week; whether the place is open
 * now (`openState`) keeps the holidays.
 */
function buildWeek(raw: string, place: HoursPlace, now: Date, locale: string): WeekDay[] | null {
  const hours = parse(raw, place.country?.toLowerCase());
  if (hours === null) return null;
  const here = wallClock(now, timeZoneOf(place.lat, place.lon));
  if (here === undefined) return null;
  const twelveHour = usesTwelveHour(locale);
  const time = (at: Date) => formatTime(at, twelveHour, false);
  /** Midnight at the start of the day `offset` days from today, on the place's clock. */
  const midnight = (offset: number) => new Date(here.getFullYear(), here.getMonth(), here.getDate() + offset);
  const holiday = (offset: number) =>
    hours.getPublicHolidayContext(new Date(here.getFullYear(), here.getMonth(), here.getDate() + offset, 12)).isHoliday;

  let first = 0;
  if (NAMES_HOLIDAYS.test(raw)) {
    // The day before and the day after count too: "PH -1 day" and "PH +1 day" are rules of their own.
    const weeks = Array.from({ length: REGULAR_WEEK_SEARCH }, (_, week) => week * 7);
    const regular = weeks.find((from) => !Array.from({ length: 9 }, (_, day) => from - 1 + day).some(holiday));
    if (regular === undefined) return null;
    first = regular;
  }

  /** The day at `offset`. `carriedIn`: the day before ran past midnight into it, and says so. Null: it cannot be stated. */
  const rowOf = (offset: number, carriedIn: boolean): Row | null => {
    const start = midnight(offset);
    const end = midnight(offset + 1);
    if (maybeMoved(start) || maybeMoved(end)) return null;
    const intervals = hours.getOpenIntervals(start, end);
    // An opening the parser cannot vouch for, or one with a note, is more than a time: the hours as written say it.
    if (intervals.some(([from, to, unknown, comment]) => unknown || comment !== undefined || maybeMoved(from) || maybeMoved(to))) {
      return null;
    }
    // getDay() counts from Sunday, the copy list from Monday.
    const weekday = (start.getDay() + 6) % 7;
    const [only] = intervals;
    if (intervals.length === 1 && only !== undefined && only[0] <= start && only[1] >= end) {
      return { weekday, ranges: [copy.hours.open24], carriesOver: false };
    }
    const ranges: string[] = [];
    let carriesOver = false;
    for (const [from, to] of intervals) {
      // The end of the night before, which the day before's row says already ("11 am to 2 am").
      if (carriedIn && from.getTime() === start.getTime()) continue;
      let until = time(to);
      if (to.getTime() === end.getTime()) {
        // Open as the day ends: a late night that closes the next morning is this day's ("6 pm to
        // 2 am"). Anything else ends here at midnight, and the next day shows its own opening from
        // midnight ("12 am to 5 pm"), so that day is not called closed.
        const limit = midnight(offset + 2);
        const closes = hours.getState(end) ? hours.getNextChange(end, limit) : undefined;
        if (closes !== undefined && closes < limit && closes.getHours() < NIGHT_ENDS_BEFORE_HOUR) {
          // A closing the runtime's zone may have moved is not a time to state, as in `openState`.
          if (maybeMoved(closes)) return null;
          until = time(closes);
          carriesOver = true;
        } else {
          until = copy.hours.midnight;
        }
      }
      ranges.push(copy.hours.range(time(from), until));
    }
    return { weekday, ranges, carriesOver };
  };

  const before = rowOf(first - 1, false);
  if (before === null) return null;
  const week: Row[] = [];
  let carried = before.carriesOver;
  for (let day = 0; day < 7; day += 1) {
    const row = rowOf(first + day, carried);
    if (row === null) return null;
    week.push(row);
    carried = row.carriesOver;
  }
  // Closed all week and not for good: a season that is over for now. The hours as written say when it opens.
  if (week.every(({ ranges }) => ranges.length === 0) && !SHUT.test(raw)) return null;
  return week
    .sort((a, b) => a.weekday - b.weekday)
    .map(({ weekday, ranges }) => ({ day: copy.hours.weekdaysShort[weekday] ?? "", ranges }));
}

/**
 * A place's hours for the seven days from `now`, Monday first, as a table for the place page: each
 * day's openings in the locale's clock ("9:30 am to 5:30 pm", "11 am to 2 am" for a night that runs
 * past midnight into the morning, put on the day it starts), "Open 24 hours" for a day that never
 * closes, and none for a day it is closed. The days are the place's own, on its clock and calendar.
 * It is the regular week: a week ahead with a public holiday in it gives way to the next one without
 * (see `buildWeek`).
 *
 * Null when the app cannot state the hours as a table: when there are none, or when `openState`
 * would show them as written, or when a table would leave out what they say (a note on a rule, an
 * opening the parser cannot vouch for, a season that is over until next year). Never throws.
 */
export function weekTable(place: HoursPlace, now: Date, locale: string): WeekDay[] | null {
  const state = openState(place, now);
  const raw = place.openingHours;
  if (state.kind === "unknown" || state.kind === "unparsed" || raw === undefined) return null;
  try {
    return quietly(() => buildWeek(raw, place, now, locale));
  } catch {
    return null;
  }
}
