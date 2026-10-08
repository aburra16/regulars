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

/**
 * A relay that keeps people's relay lists and little else, asked beside the review relays, for the
 * person who has put theirs on neither.
 */
export const RELAY_LIST_DIRECTORY = "wss://purplepag.es";

/** The most relays a review goes to, the review relays among them. */
export const MAX_WRITE_RELAYS = 6;

/** `text` as a URL with a `wss://` address, null if it is not one. Anything with a password in it is not one. */
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

/** The host of a URL as a name or an address, without the dot that ends a fully qualified name. */
const hostOf = (url: URL) => url.hostname.replace(/\.$/, "");

/** Whether `ip`, an IPv6 address as URL writes it (in brackets, in lower case), is this machine's, a local network's, or a mapped IPv4's. */
function isPrivateV6(ip: string): boolean {
  const address = ip.slice(1, -1);
  return (
    address === "::1" ||
    address === "::" ||
    address.startsWith("::ffff:") ||
    /^f[cd]/.test(address) || // fc00::/7, the unique local addresses
    /^fe[89ab]/.test(address) // fe80::/10, the link-local addresses
  );
}

/**
 * Whether `host` (from `hostOf`) names this machine, a local network, or somewhere with no public
 * name: a relay list is anyone's to write, and a browser that opened such an address would be
 * reaching into the network it runs on. `URL` has already turned an address written as a number, or
 * in hex, into four decimal parts.
 */
function isPrivateHost(host: string): boolean {
  if (host.startsWith("[")) return isPrivateV6(host);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".onion")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 || // this host
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, where clouds keep their metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  // A name with no dot is one of the local network's (or a search domain's), not the internet's.
  return !host.includes(".");
}

/**
 * The address of a relay, written one way: lower-case host, the default port and a trailing slash
 * and dot left out, and no query or fragment (a token in one does not belong in an address kept in
 * a list). The same relay written two ways gives the same address.
 */
function addressOf(url: URL): string {
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${hostOf(url)}${port}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The address of the relay a person's list or signer names, or null if it is not one to send a
 * review to: only `wss://`, and not on this machine or a local network (see `isPrivateHost`).
 */
function publicRelayAddress(text: unknown): string | null {
  const url = parseRelayUrl(text, /^wss:\/\//i);
  return url === null || isPrivateHost(hostOf(url)) ? null : addressOf(url);
}

/**
 * The address of a relay the app is set up with (`config.reviewRelays`). These are the app's own, not
 * a stranger's: in development one may be `ws://localhost`, and is where the review should go.
 */
function configuredRelayAddress(text: string): string | null {
  const url = parseRelayUrl(text, /^wss?:\/\//i);
  return url === null ? null : addressOf(url);
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
 * The newest relay list of `pubkey` among the relays asked: the review relays and the directory,
 * read side by side. Null when none has one. A relay that fails has none. Throws only when `signal`
 * aborts. `readers` must check signatures (`readerFor` does): anyone can write a list naming anyone.
 */
async function newestRelayList(
  pubkey: string,
  readers: (url: string) => RelayReader,
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  // The same relay written two ways is read once. The first way keeps its read extras, which are by address as written.
  const asked = new Map<string, string>();
  for (const url of [...config.reviewRelays, RELAY_LIST_DIRECTORY]) {
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
 * the directory; if none of them has a list, those their `signer` reports. Each address once,
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
