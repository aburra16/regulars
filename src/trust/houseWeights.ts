import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { isPubkey, isRelayUrl } from "../nostr/shapes.ts";
import { asEvent, isNewer, type RelayReader } from "../places/load.ts";

/** The kind of the list in which an account names its scorers (NIP-85). */
const TRUST_LIST_KIND = 10040;

/** The kind of a scorer's ranks for one person: one event per person, whose `d` is their public key. */
const RANK_KIND = 30382;

/** The most people one request for ranks names (Brainstorm reads at most 500 items at a time). */
const RANK_BATCH = 500;

/** A rank as a scorer writes it: a plain decimal number, such as "6" or "12.5". */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** An account that publishes trust ranks (kind 30382), and the relay it publishes them to. */
export interface Scorer {
  pubkey: string;
  relay: string;
}

/**
 * The scorer that `house` names in its newest kind 10040 among `values`: the first `30382:rank`
 * tag, `["30382:rank", <scorer>, <relay>]`. Null when there is no such list, or when its tag is
 * missing or malformed. A newer list replaces an older one even when it names no scorer.
 */
export function scorerFrom(values: readonly unknown[], house: string): Scorer | null {
  let newest: NostrEvent | undefined;
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== TRUST_LIST_KIND || ev.pubkey !== house) continue;
    if (newest === undefined || isNewer(ev, newest)) newest = ev;
  }
  const [, pubkey, relay] = newest?.tags.find((tag) => tag[0] === "30382:rank") ?? [];
  if (pubkey === undefined || relay === undefined) return null;
  return isPubkey(pubkey) && isRelayUrl(relay) ? { pubkey, relay } : null;
}

/** The rank in a 30382's tags, from 0 to 100, or undefined when it is missing or anything else. */
function rankIn(tags: readonly string[][]): number | undefined {
  const text = tags.find((tag) => tag[0] === "rank")?.[1];
  if (text === undefined || !DECIMAL.test(text)) return undefined;
  const rank = Number(text);
  return rank <= 100 ? rank : undefined;
}

/**
 * Each person's rank by `scorer` among `values`, from the newest of its kind 30382 events about
 * them. A person whose newest event has no rank from 0 to 100 is left out, so counts as outside
 * (Review Focus 1): an older, good rank does not stand in for it.
 */
export function ranksFrom(values: readonly unknown[], scorer: string): Map<string, number> {
  const newest = new Map<string, NostrEvent>();
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== RANK_KIND || ev.pubkey !== scorer) continue;
    const subject = ev.tags.find((tag) => tag[0] === "d")?.[1];
    if (subject === undefined || !isPubkey(subject)) continue;
    const kept = newest.get(subject);
    if (kept === undefined || isNewer(ev, kept)) newest.set(subject, ev);
  }

  const ranks = new Map<string, number>();
  for (const [subject, ev] of newest) {
    const rank = rankIn(ev.tags);
    if (rank !== undefined) ranks.set(subject, rank);
  }
  return ranks;
}

/**
 * How much a reviewer with `rank` counts, from 0 to 1: the rank out of 100, from `line` up. Below
 * the line, or with no rank, it is 0: the reviewer is outside the view.
 */
export function weightOf(rank: number | undefined, line: number): number {
  // Written so that NaN, which fails every comparison, gives 0 too.
  return rank !== undefined && rank >= line && rank <= 100 ? rank / 100 : 0;
}

/** Every event `url`'s relay sends for `filter`. */
async function readAll(
  readers: (url: string) => RelayReader,
  url: string,
  filter: NostrFilter,
  signal: AbortSignal,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of readers(url).req(filter, signal)) values.push(value);
  return values;
}

/**
 * The scorer whose ranks are House picks: in development, `config.devScorer` when it is set,
 * with no request; otherwise the one the house's newest kind 10040 names, read from each of
 * `config.houseTrustRelays`. Null when no relay that answered has one, or none answered: the
 * house's view is unavailable, which is not an error. Throws only when `signal` aborts.
 */
export async function resolveScorer(
  readers: (url: string) => RelayReader,
  signal: AbortSignal,
): Promise<Scorer | null> {
  if (config.devScorer !== undefined) return config.devScorer;

  // The list is replaceable: a relay keeps only the newest, so one is all there is to ask for.
  const filter: NostrFilter = { kinds: [TRUST_LIST_KIND], authors: [config.houseHex], limit: 1 };
  const reads = await Promise.allSettled(
    config.houseTrustRelays.map((url) => readAll(readers, url, filter, signal)),
  );
  signal.throwIfAborted();
  const values = reads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
  return scorerFrom(values, config.houseHex);
}

/**
 * The ranks that `scorer` gives `pubkeys`, read from its relay through `reader`, 500 people to a
 * request, one request after another. Someone it has not ranked is not in the map. Throws when a
 * request fails or `signal` aborts, so a partial set of ranks is never taken for the whole.
 */
export async function fetchRanks(
  reader: RelayReader,
  scorer: string,
  pubkeys: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const subjects = [...new Set(pubkeys)];
  const values: unknown[] = [];
  for (let start = 0; start < subjects.length; start += RANK_BATCH) {
    signal.throwIfAborted();
    const batch = subjects.slice(start, start + RANK_BATCH);
    // One event per person: the kind is addressable, so a relay keeps only the newest of each.
    const filter: NostrFilter = { kinds: [RANK_KIND], authors: [scorer], "#d": batch, limit: batch.length };
    for await (const value of reader.req(filter, signal)) values.push(value);
  }
  // A reader that stops quietly when aborted must not pass for one that sent every rank.
  signal.throwIfAborted();
  return ranksFrom(values, scorer);
}
