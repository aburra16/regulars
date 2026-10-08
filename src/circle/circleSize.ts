import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { asEvent, isNewer, type RelayReader, readAll } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { RANK_KIND, ranksFrom, type Scorer, weightOf } from "../trust/houseWeights.ts";
import { loadClient } from "./client.ts";
import { forgetToken, readToken } from "./token.ts";

/*
 * How many people are in the person's circle, for the Why page: a count of people, which decision 19
 * allows ("212 people in your circle"), never a number on one of them. The circle is who counts in My
 * circle's scores: the people the person's scorer ranks at or above the line (`config.scoring.line`),
 * the person aside.
 *
 * Two places say it, and neither says it whole:
 * - The scorer's ranks on its relay (kind 30382), with no token. They are exact, and say who the
 *   person trusts (`hops` 1) and who those people trust. But Brainstorm publishes everyone at rank 2
 *   and up, a whole run's worth within a few seconds, and a relay sends at most 500 a request, paged
 *   back by time: a page that gets no further back in time, or more pages than are read, leaves some
 *   unread, and then what was counted is only a floor.
 * - The run's `count_values` (`GET /user/graperankResult`), with the token this tab has once the
 *   person personalized. It buckets everyone by Brainstorm's tiers (high from influence 0.5, medium-high
 *   from 0.2, medium from 0.07, then under), not at the line, so it gives only a floor too: the people
 *   in tiers that start at or above the line. It costs one request, so it stands in for reading the
 *   relay when its floor is more than the relay's pages could count.
 */

/** The most ranks one request asks for: as many as a relay sends (Brainstorm reads 500 at a time). */
export const RANK_PAGE = 500;

/** The most pages of ranks read: 2,000 ranks, each checked as it comes. Past them, the count is a floor. */
export const RANK_PAGES = 4;

/** How many are in the circle: all of them, split by who trusts whom, or at least `n`. */
export type CircleSize =
  | { kind: "exact"; total: number; direct: number; further: number }
  | { kind: "atLeast"; n: number };

/** The rank, out of 100, from which each of Brainstorm's tiers starts (`count_values`'s keys). */
const TIER_FLOORS: Readonly<Record<string, number>> = { high: 50, medium_high: 20, medium: 7 };

/** Whether `value` is a JSON object. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How many people the run's `count_values` (tier, then hops from the person, then how many) puts at
 * or above `line` for sure: those in the tiers that start at or above it, but the person (hop 0). A
 * floor, as the tier below them starts under any line above 2. Zero when it is missing or unreadable.
 */
export function floorFromRun(countValues: string | null, line: number): number {
  if (countValues === null || countValues === "") return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(countValues);
  } catch {
    return 0;
  }
  if (!isObject(parsed)) return 0;
  let n = 0;
  for (const [tier, floor] of Object.entries(TIER_FLOORS)) {
    const byHops = parsed[tier];
    if (floor < line || !isObject(byHops)) continue;
    for (const [hops, count] of Object.entries(byHops)) {
      if (hops !== "0" && typeof count === "number" && Number.isSafeInteger(count) && count > 0) n += count;
    }
  }
  return n;
}

/**
 * The circle as `scorer`'s ranks on its relay say, through `reader`: the people it ranks at or above
 * `line`, but `owner`, split by whether `owner` trusts them (`hops` 1) or someone they trust does;
 * and when the newest rank was published (seconds), which is when the circle was last worked out. It
 * reads `RANK_PAGE` ranks at a time, newest first, then those up to the oldest time seen (that second
 * included, so nothing of it is skipped), for at most `RANK_PAGES` pages. The count is exact when a
 * page comes back short; a full page that gets no further back in time (a run publishes thousands in a
 * second) is followed by one from the second before, and from then on, as past the last page, it is a
 * floor. Throws when a read fails or `signal` aborts.
 */
export async function countRanks(
  reader: RelayReader,
  scorer: string,
  owner: string,
  line: number,
  signal: AbortSignal,
): Promise<{ size: CircleSize; newest?: number }> {
  const filter: NostrFilter = { kinds: [RANK_KIND], authors: [scorer], limit: RANK_PAGE };
  const values: unknown[] = [];
  let until: number | undefined;
  let complete = false;
  let skipped = false;
  for (let page = 0; page < RANK_PAGES; page++) {
    const read = await readAll(reader, until === undefined ? filter : { ...filter, until }, signal);
    values.push(...read);
    if (read.length < RANK_PAGE) {
      complete = true;
      break;
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const value of read) {
      const ev = asEvent(value);
      if (ev !== null && ev.created_at < oldest) oldest = ev.created_at;
    }
    if (!Number.isFinite(oldest)) break;
    let next = oldest;
    if (until !== undefined && oldest >= until) {
      // Every one of the page is from the second asked up to: what else it holds is not read.
      skipped = true;
      next = oldest - 1;
    }
    if (next < 0) {
      complete = true;
      break;
    }
    until = next;
  }
  // A reader that stops quietly when aborted must not pass for one that sent every rank.
  signal.throwIfAborted();

  const newestOf = new Map<string, NostrEvent>();
  let newest: number | undefined;
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== RANK_KIND || ev.pubkey !== scorer) continue;
    if (newest === undefined || ev.created_at > newest) newest = ev.created_at;
    const subject = ev.tags.find((tag) => tag[0] === "d")?.[1];
    if (subject === undefined || !isHex64(subject) || subject === owner) continue;
    const kept = newestOf.get(subject);
    if (kept === undefined || isNewer(ev, kept)) newestOf.set(subject, ev);
  }
  const ranks = ranksFrom([...newestOf.values()], scorer);
  let direct = 0;
  let further = 0;
  for (const [subject, ev] of newestOf) {
    if (weightOf(ranks.get(subject), line) === 0) continue;
    if (ev.tags.find((tag) => tag[0] === "hops")?.[1] === "1") direct += 1;
    else further += 1;
  }
  const size: CircleSize =
    complete && !skipped ? { kind: "exact", total: direct + further, direct, further } : { kind: "atLeast", n: direct + further };
  return { size, newest };
}

/** The circle's size, and when it was worked out (milliseconds since 1970), when that is known. */
export interface Counted {
  size: CircleSize;
  workedOut?: number;
}

/**
 * How many are in `owner`'s circle, whose ranks `scorer` publishes, read through `readers`. With a
 * token this tab has (the person personalized this session), the latest run says when it was worked
 * out, and gives its floor; a token Brainstorm refuses is let go of, and nobody is asked to sign
 * anything (they did not act). Brainstorm not answering is no matter: the relay is read. Throws when the
 * relay cannot be read, or `signal` aborts.
 */
export async function sizeOfCircle({
  owner,
  scorer,
  readers,
  signal,
}: {
  owner: string;
  scorer: Scorer;
  readers: (url: string) => RelayReader;
  signal: AbortSignal;
}): Promise<Counted> {
  const { line } = config.scoring;
  let floor = 0;
  let workedOut: number | undefined;
  const token = readToken(owner);
  if (token !== null) {
    try {
      const client = await loadClient();
      try {
        const run = await client.latestRun(token, signal);
        if (run !== null && client.runState(run) === "done") {
          workedOut = run.updatedAt;
          floor = floorFromRun(run.countValues, line);
        }
      } catch (error) {
        if (error instanceof client.TokenExpired) forgetToken();
        throw error;
      }
    } catch {
      signal.throwIfAborted();
      // Brainstorm could not be reached, or its client did not load: the relay alone says.
    }
  }
  if (floor >= RANK_PAGE * RANK_PAGES) return { size: { kind: "atLeast", n: floor }, workedOut };

  const counted = await countRanks(readers(scorer.relay), scorer.pubkey, owner, line, signal);
  const size: CircleSize = counted.size.kind === "atLeast" ? { kind: "atLeast", n: Math.max(counted.size.n, floor) } : counted.size;
  return { size, workedOut: workedOut ?? (counted.newest === undefined ? undefined : counted.newest * 1000) };
}
