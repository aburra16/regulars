import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { asEvent, isNewer, type RelayReader, readAll, withReadExtras } from "../nostr/events.ts";

/*
 * Where a review goes: the relays its author publishes to (NIP-65), so that the people who follow
 * them can find it, and always the review relays, where the app reads reviews from. This reads
 * through a `RelayReader` it is given and loads nothing of Nostrify, so the first screen may reach it.
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
 * address returned is one that passes the same check again.
 */
function publicRelayAddress(text: unknown): string | null {
  const url = parseRelayUrl(text, /^wss:\/\//i);
  const sent = url === null ? null : settled(url);
  return sent === null || isPrivateHost(hostOf(sent)) ? null : addressOf(sent);
}

/**
 * The address of a relay the app is set up with (`config.reviewRelays`, `config.relayListRelays`).
 * These are the app's own, not a stranger's: in development one may be `ws://localhost`, and is
 * where the review should go. So `ws://` and private hosts are kept.
 */
function configuredRelayAddress(text: string): string | null {
  const url = parseRelayUrl(text, /^wss?:\/\//i);
  const sent = url === null ? null : settled(url);
  return sent === null ? null : addressOf(sent);
}

/** `promise`, or the signal's reason as soon as it aborts, whichever is first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
 * The newest relay list of `pubkey` among the relays asked: the review relays and the relay-list
 * relays (`config.relayListRelays`), read side by side. Null when none has one. A relay that fails has none. Throws only when `signal`
 * aborts. `readers` must check signatures (`readerFor` does): anyone can write a list naming anyone.
 */
async function newestRelayList(
  pubkey: string,
  readers: (url: string) => RelayReader,
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  // The same relay written two ways is read once. The first way keeps its read extras, which are by address as written.
  const asked = new Map<string, string>();
  for (const url of [...config.reviewRelays, ...config.relayListRelays]) {
    const address = configuredRelayAddress(url);
    if (address !== null && !asked.has(address)) asked.set(address, url);
  }

  // A list is replaceable: a relay keeps one per person, so one is all there is to ask for.
  const filter: NostrFilter = { kinds: [RELAY_LIST_KIND], authors: [pubkey], limit: 1 };
  const reads = await Promise.allSettled(
    [...asked.values()].map(async (url) => readAll(withReadExtras(readers(url), config.relayReadExtras[url]), filter, signal)),
  );
  signal.throwIfAborted();

  let newest: NostrEvent | null = null;
  for (const read of reads) {
    if (read.status !== "fulfilled") continue;
    for (const value of read.value) {
      const ev = asEvent(value);
      if (ev === null || ev.kind !== RELAY_LIST_KIND || ev.pubkey !== pubkey) continue;
      if (newest === null || isNewer(ev, newest)) newest = ev;
    }
  }
  return newest;
}

/** The relays a relay list writes to, in its order: an `r` tag with no marker, or marked "write" (NIP-65). */
function writtenTo(list: NostrEvent): string[] {
  return list.tags.flatMap((tag) => (tag[0] === "r" && (tag[2] === undefined || tag[2] === "write") ? [tag[1] ?? ""] : []));
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
  readers: (url: string) => RelayReader,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();

  const list = await newestRelayList(pubkey, readers, signal);
  const theirs = list !== null ? writtenTo(list) : await signerWritesTo(signer, signal);

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
