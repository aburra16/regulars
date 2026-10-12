import { copy } from "../copy/en.ts";

/**
 * The moment a review written at `createdAt` (seconds) was written, as a date; undefined for a time
 * no date can hold (past ±8.64e12 seconds, or not a number), which a page must not try to show.
 */
export function writtenOn(createdAt: number): Date | undefined {
  const date = new Date(createdAt * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** The day `date` falls on, on the person's own calendar, as a count of days. */
const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/**
 * How long before `now` the moment `createdAt` (seconds) is, in the person's own calendar: how many
 * calendar days, and how many whole calendar months (a month is whole once its day of the month has
 * come round again).
 */
function calendarSince(createdAt: number, now: Date): { days: number; months: number } {
  const written = new Date(createdAt * 1000);
  const days = dayOf(now) - dayOf(written);
  let months = (now.getFullYear() - written.getFullYear()) * 12 + (now.getMonth() - written.getMonth());
  if (now.getDate() < written.getDate()) months -= 1;
  return { days, months };
}

/**
 * When a review written at `createdAt` (seconds) was written, as of `now`, in the person's own
 * calendar: "Today" for the same calendar day, "Yesterday" for the day before however few hours ago,
 * and then days, weeks, whole calendar months, and years once a full year has passed (360 days back
 * is "11 months ago", never "12 months ago"). A review from a clock ahead of the person's is "Today".
 */
export function whenWritten(createdAt: number, now: Date): string {
  const { days, months } = calendarSince(createdAt, now);
  return copy.reviews.when(days, months);
}

/**
 * How long ago a review written at `createdAt` (seconds) was written, as of `now`, for Recent: in
 * minutes and hours under a day ("2 hours ago"), then by the person's own calendar, from "yesterday"
 * on, as `whenWritten` counts. A review from a clock ahead of the person's is "now".
 */
export function howLongAgo(createdAt: number, now: Date): string {
  const seconds = Math.max(0, Math.floor(now.getTime() / 1000) - createdAt);
  const { days, months } = calendarSince(createdAt, now);
  return copy.recent.when(seconds, days, months);
}
