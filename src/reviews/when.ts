import { copy } from "../copy/en.ts";

/** The day `date` falls on, on the person's own calendar, as a count of days. */
const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/**
 * When a review written at `createdAt` (seconds) was written, as of `now`, in the person's own
 * calendar: "Today" for the same calendar day, "Yesterday" for the day before however few hours ago,
 * and then days, weeks, whole calendar months, and years once a full year has passed (360 days back
 * is "11 months ago", never "12 months ago"). A review from a clock ahead of the person's is "Today".
 */
export function whenWritten(createdAt: number, now: Date): string {
  const written = new Date(createdAt * 1000);
  const days = dayOf(now) - dayOf(written);
  let months = (now.getFullYear() - written.getFullYear()) * 12 + (now.getMonth() - written.getMonth());
  // A month is whole once its day of the month has come round again.
  if (now.getDate() < written.getDate()) months -= 1;
  return copy.reviews.when(days, months);
}
