import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { asEvent, isNewer, type Readers, type ReadOptions, readAll, withReadExtras } from "../nostr/events.ts";

/*
 * Where a review goes: the relays its author publishes to (NIP-65), so that the people who follow
 * them can find it, and always the review relays, where reviews are posted (`config.reviewRelays`);
 * the app reads them from those and the list hub (`config.reviewReadRelays`). This reads through a
 * `RelayReader` it is given and loads nothing of Nostrify, so the first screen may reach it.
 */

/** The kind of a person's relay list (NIP-65), a replaceable event: its `r` tags name the relays. */
export const RELAY_LIST_KIND = 10002;

/** The most relays a review goes to, the review relays among them. */
export const MAX_WRITE_RELAYS = 6;

/**
 * `text` as a URL whose scheme begins as `schemes` says, null if it is not one or it carries a
 * password. A relay that a person or their signer names must be `wss://`: `ws://` is accepted only
 * on the trusted path, for the relays the app is set up with (`configuredRelayAddress`).
 */
function parseRelayUrl(text: unknown, schemes: RegExp): URL | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  // `new URL` takes "wss:host" and "wss:\\host" for "wss://host"; an entry written so is not a relay's address.
  if (!schemes.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

/** The host of a URL as a name or an address, without the dots that end it: `URL` keeps every one of them. */
const hostOf = (url: URL) => url.hostname.replace(/\.+$/, "");

/** Whether an IPv4 address that begins `a.b` is this machine's, a local network's, or one no relay is reached at. */
function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 0 || // this host
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where clouds keep their metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // kept for benchmarks
    a >= 224 // multicast (224.0.0.0/4) and reserved (240.0.0.0/4), the broadcast address with them
  );
}

/** The eight groups of the IPv6 address `address` (no brackets), as `URL` writes it; null if it is not one. */
function groupsOf(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (text: string | undefined) => (text === undefined || text === "" ? [] : text.split(":"));
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const numbers = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

/**
 * Whether the IPv6 address `address` (no brackets) is this machine's, a local network's, or an
 * IPv4 address of either in another dress. One it cannot read is private: better to drop a relay
 * than to reach into the network the app runs on.
 */
function isPrivateV6(address: string): boolean {
  const g = groupsOf(address);
  if (g === null) return true;
  const [first = 0, second = 0] = g;
  const embeddedV4 = (group: number | undefined) => isPrivateV4((group ?? 0) >> 8, (group ?? 0) & 0xff);
  if (g.slice(0, 6).every((n) => n === 0)) return true; // ::/96, which has the unspecified address, loopback, and IPv4-compatible ones
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return true; // ::ffff:0:0/96, IPv4-mapped
  if (first === 0x64 && second === 0xff9b) {
    if (g[2] === 1) return true; // 64:ff9b:1::/48, NAT64 for a local network
    if (g.slice(2, 6).every((n) => n === 0)) return embeddedV4(g[6]); // 64:ff9b::/96, NAT64 to the IPv4 in the last 32 bits
  }
  if (first === 0x2002) return embeddedV4(second); // 6to4, the IPv4 in the next 32 bits
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7, unique local
    (first & 0xff80) === 0xfe80 || // fe80::/10 link-local and fec0::/10 site-local
    (first & 0xff00) === 0xff00 // ff00::/8, multicast
  );
}

/**
 * Whether `host` (from `hostOf`) names this machine, a local network, or somewhere with no public
 * name: a relay list is anyone's to write, and a browser that opened such an address would be
 * reaching into the network it runs on. `URL` has turned an address written as a number, or in hex,
 * into four decimal parts, but only when no dot ends it (`publicRelayAddress` reads the address again).
 */
function isPrivateHost(host: string): boolean {
  if (host === "") return true;
  if (host.startsWith("[")) return isPrivateV6(host.slice(1, -1));
  if (host === "localhost" || /\.(?:localhost|local|localdomain|onion)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  // A name with no dot is one of the local network's (or a search domain's), not the internet's.
  return !host.includes(".");
}

/**
 * The address of a relay, written one way: lower-case host, the default port and the trailing
 * dots and slashes left out, and no query or fragment (a token in one does not belong in an address
 * kept in a list). The same relay written two ways gives the same address.
 */
function addressOf(url: URL): string {
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${hostOf(url)}${port}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * `url` as `addressOf` writes it, read again as a URL: null if what is left is not one. The dots that
 * end a host are what hide a number from `URL` ("127.0.0.1.." is a name to it, "127.0.0.1" a loopback
 * address), so a host is judged only once they are gone.
 */
function settled(url: URL): URL | null {
  try {
    return new URL(addressOf(url));
  } catch {
    return null;
  }
}

/**
 * The address of the relay a person's list or signer names, or null if it is not one to send a
 * review to: only `wss://`, and not on this machine or a local network (see `isPrivateHost`). The
 * address returned is one that passes the same check again. A link a phone app gives the person to
 * paste (src/account/connect.ts) is held to it too.
 */
export function publicRelayAddress(text: unknown): string | null {
  const url = parseRelayUrl(text, /^wss:\/\//i);
  const sent = url === null ? null : settled(url);
  return sent === null || isPrivateHost(hostOf(sent)) ? null : addressOf(sent);
}

/**
 * The address of a relay the app is set up with (`config.reviewRelays`, `config.relayListRelays`,
 * `config.followListRelays`). These are the app's own, not a stranger's: in development one may be
 * `ws://localhost`, and is where the review should go. So `ws://` and private hosts are kept.
 */
export function configuredRelayAddress(text: string): string | null {
  const url = parseRelayUrl(text, /^wss?:\/\//i);
  const sent = url === null ? null : settled(url);
  return sent === null ? null : addressOf(sent);
}

/**
 * The address of a relay a review, or its removal, may be sent to, written one way, or null: a review
 * relay, as the app is set up with it (`configuredRelayAddress`), or a public one (`publicRelayAddress`).
 * Where a review went, kept by the tab, is held to it again before its removal is sent there.
 */
export function sendableRelayAddress(url: string): string | null {
  return isReviewRelay(url) ? configuredRelayAddress(url) : publicRelayAddress(url);
}

/**
 * Whether the relay at `url` is one of the review relays (`config.reviewRelays`), where reviews are
 * posted (they are read from `config.reviewReadRelays`), however either is written: both are compared
 * as `configuredRelayAddress` writes them.
 */
export function isReviewRelay(url: string): boolean {
  const address = configuredRelayAddress(url);
  return address !== null && config.reviewRelays.some((relay) => configuredRelayAddress(relay) === address);
}

/** `promise`, or the signal's reason as soon as it aborts, whichever is first. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Every value the relay at `url` sends for `filter`, with what a read from it adds
 * (`config.relayReadExtras`), once it has sent them all. Fails when the relay does, when it does not
 * finish within `ms`, or when `signal` aborts (the signal's reason): the relay is asked to stop, and
 * a reader that takes no notice of that is let go all the same. `opts` is passed on to the relay's
 * reader: with `failFast`, a relay that is out fails at once, not after its `ms`.
 */
export async function readWithin(
  url: string,
  filter: NostrFilter,
  readers: Readers,
  signal: AbortSignal,
  ms: number,
  opts?: ReadOptions,
): Promise<unknown[]> {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(new DOMException(`${url} did not answer in time`, "TimeoutError")), ms);
  const stop = AbortSignal.any([signal, late.signal]);
  try {
    return await abortable(readAll(withReadExtras(readers(url), config.relayReadExtras[url]), filter, stop, opts), stop);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest relay list of `pubkey` among the relays asked, and which of those relays answered: the
 * review relays and the relay-list relays (`config.relayListRelays`), read side by side. `newest` is
 * null when none sent one. A relay that fails has none, and has not answered; nor, when `within` is
 * given, has one that does not answer within that many milliseconds (`readWithin`), so that one
 * stalled relay does not cost the list another sent. With no `within` every relay is waited for, and
 * the caller sets what time the whole read has. `answered` holds each relay that sent what it has to
 * the end, as `configuredRelayAddress` writes its address. Throws only when `signal` aborts. `readers`
 * must check signatures (`readerFor` does): anyone can write a list naming anyone. `opts` is passed
 * on to each relay's reader.
 */
async function newestRelayList(
  pubkey: string,
  readers: Readers,
  signal: AbortSignal,
  within?: number,
  opts?: ReadOptions,
): Promise<{ newest: NostrEvent | null; answered: ReadonlySet<string> }> {
  // The same relay written two ways is read once. The first way keeps its read extras, which are by address as written.
  const asked = new Map<string, string>();
  for (const url of [...config.reviewRelays, ...config.relayListRelays]) {
    const address = configuredRelayAddress(url);
    if (address !== null && !asked.has(address)) asked.set(address, url);
  }

  // A list is replaceable: a relay keeps one per person, so one is all there is to ask for.
  const filter: NostrFilter = { kinds: [RELAY_LIST_KIND], authors: [pubkey], limit: 1 };
  const addresses = [...asked.keys()];
  const reads = await Promise.allSettled(
    [...asked.values()].map(async (url) =>
      within === undefined
        ? readAll(withReadExtras(readers(url), config.relayReadExtras[url]), filter, signal, opts)
        : readWithin(url, filter, readers, signal, within, opts),
    ),
  );
  signal.throwIfAborted();

  let newest: NostrEvent | null = null;
  const answered = new Set<string>();
  reads.forEach((read, at) => {
    if (read.status !== "fulfilled") return;
    answered.add(addresses[at]!);
    for (const value of read.value) {
      const ev = asEvent(value);
      if (ev === null || ev.kind !== RELAY_LIST_KIND || ev.pubkey !== pubkey) continue;
      if (newest === null || isNewer(ev, newest)) newest = ev;
    }
  });
  return { newest, answered };
}

/** The relays a relay list names with `marker` (or with none, which is both), in its order: `r` tags (NIP-65). */
function relaysOf(list: NostrEvent, marker: "read" | "write"): string[] {
  return list.tags.flatMap((tag) => (tag[0] === "r" && (tag[2] === undefined || tag[2] === marker) ? [tag[1] ?? ""] : []));
}

/**
 * The relays a person's newest relay list (NIP-65) writes to and reads from, as the list wrote them
 * and in its order (an `r` tag with no marker is in both), or null when no relay sent a list: for a
 * review, which goes to the review relays whatever this finds, so a list that is not there and one
 * that could not be read are the same to it. Every relay is waited for, and the caller sets what
 * time the whole read has; a relay that fails has none, and only an abort of `signal` throws. The
 * addresses are anyone's to write: a caller holds each to `publicRelayAddress` before it uses it.
 */
export async function relayListOf(pubkey: string, readers: Readers, signal: AbortSignal): Promise<{ write: string[]; read: string[] } | null> {
  const { newest } = await newestRelayList(pubkey, readers, signal);
  return newest === null ? null : { write: relaysOf(newest, "write"), read: relaysOf(newest, "read") };
}

/**
 * What the relays say of a person's relay list, for a reader that must tell a list that is not
 * there from one that could not be read (ruling R43):
 * - `found`: a relay sent one. The relays the newest writes to and reads from, as `relayListOf`
 *   gives them;
 * - `none`: no relay sent one, and every relay-list relay (`config.relayListRelays`) answered. Those
 *   are where a person's list is kept, when they have one;
 * - `unknown`: no relay sent one, and a relay-list relay did not answer, or there is none to ask:
 *   they may have one.
 * The review relays are asked too, as more chances to find a list. Their having none is no proof
 * that there is none, and their silence takes nothing from a `none`.
 */
export type RelayListRead = { is: "found"; write: string[]; read: string[] } | { is: "none" } | { is: "unknown" };

/**
 * A person's relay list as the relays hold it now, found, none or not known (`RelayListRead`): for
 * a follow list, which is read from the relays that list names, and must not be acted on when they
 * could not be learned of. Each relay has `within` milliseconds of its own: one that does not answer
 * in them has not answered, and the newest list among those that did is used. `opts` says how each
 * relay is read (`ReadOptions`). Throws only when `signal` aborts.
 */
export async function readRelayList(
  pubkey: string,
  readers: Readers,
  signal: AbortSignal,
  within: number,
  opts?: ReadOptions,
): Promise<RelayListRead> {
  const { newest, answered } = await newestRelayList(pubkey, readers, signal, within, opts);
  if (newest !== null) return { is: "found", write: relaysOf(newest, "write"), read: relaysOf(newest, "read") };
  // One written as no address a relay has was not asked, and so has not answered. With no
  // relay-list relay at all, nobody who would know was asked: that is not known, never none.
  const everyOneAnswered =
    config.relayListRelays.length > 0 &&
    config.relayListRelays.every((url) => {
      const address = configuredRelayAddress(url);
      return address !== null && answered.has(address);
    });
  return { is: everyOneAnswered ? "none" : "unknown" };
}

/**
 * The relays `signer` says its person writes to (NIP-07's `getRelays`, which NIP-46 signers have too).
 * None when it cannot say, fails, or answers with something that is not a list of relays. Throws only
 * when `signal` aborts.
 */
async function signerWritesTo(signer: NostrSigner, signal: AbortSignal): Promise<string[]> {
  try {
    const relays: unknown = await abortable(Promise.resolve().then(() => signer.getRelays?.()), signal);
    if (typeof relays !== "object" || relays === null || Array.isArray(relays)) return [];
    return Object.entries(relays).flatMap(([url, policy]) =>
      typeof policy === "object" && policy !== null && (policy as { write?: unknown }).write === true ? [url] : [],
    );
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

/**
 * Where a review by `pubkey` is sent. First the review relays (`config.reviewRelays`), then the
 * relays the person writes to: those of their newest relay list (NIP-65) on the review relays and
 * the relay-list relays; if none of them has a list, those their `signer` reports. Each address once,
 * `wss://` only and none on this machine or a local network, and at most `MAX_WRITE_RELAYS`.
 * A relay that fails to answer has nothing; the answer is never empty of the review relays. Throws
 * only when `signal` aborts, with its reason. Nothing here is logged: the lists are other people's.
 */
export async function writeRelaysOf(
  pubkey: string,
  signer: NostrSigner,
  readers: Readers,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();

  const list = await relayListOf(pubkey, readers, signal);
  const theirs = list !== null ? list.write : await signerWritesTo(signer, signal);

  const relays = new Set<string>();
  for (const url of config.reviewRelays) {
    const address = configuredRelayAddress(url);
    if (address !== null) relays.add(address);
  }
  for (const url of theirs) {
    const address = publicRelayAddress(url);
    if (address !== null) relays.add(address);
  }
  return [...relays].slice(0, MAX_WRITE_RELAYS);
}
