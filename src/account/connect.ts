import {
  NBrowserSigner,
  NConnectSigner,
  type NostrEvent,
  type NostrFilter,
  type NostrSigner,
  type NRelay,
  NRelay1,
  NSecSigner,
} from "@nostrify/nostrify";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

import { config } from "../config.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { type Account, saveSession, type Session } from "./session.ts";
import { abortable, publicRelayAddress } from "./writeRelays.ts";

/*
 * Signing in: with an add-on in this browser (NIP-07), or with an app on the person's phone (NIP-46),
 * by a nostrconnect link the app shows, or a bunker link the phone app gives. The person's key stays
 * in the add-on or the phone app; the app gets a signer that asks it (docs/decisions.md #21).
 * This loads Nostrify and nostr-tools' keys, so the first screen reaches it only through a dynamic
 * import() (src/account/AccountProvider.tsx), as it does the relay code: tests/relay-chunk.test.ts.
 * Nothing here is logged: what passes through it is keys and secrets.
 */

export type { Account } from "./session.ts";

/** The kind of a NIP-46 request or answer. */
const CONNECT_KIND = 24133;

/**
 * How long connecting may take in all: the person scans the code or opens the app, says yes, and the
 * phone app answers. Then it is given up, and the person told (Review Focus 3).
 */
export const CONNECT_TIMEOUT_MS = 120_000;

/**
 * How long the phone app has to answer a request once connected, such as to sign a review: the
 * person may have to find their phone and say yes on it.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * What the nostrconnect link asks the phone app to let the app do without asking each time: say who
 * the person is, and sign their reviews (34259), the removal of one (5) and their relay list (10002).
 */
const PERMISSIONS = ["get_public_key", "sign_event:34259", "sign_event:5", "sign_event:10002"];

/** The relay at an address. The app's own opens a socket; tests pass one held in memory. */
export type RelayFor = (url: string) => NRelay;

const openRelay: RelayFor = (url) => new NRelay1(url);

/** What closes the connection behind each phone signer, for `disconnect`. */
const closers = new WeakMap<NostrSigner, () => void>();

/**
 * The link the app shows a phone (NIP-46's nostrconnect): the app's key for this connection, where to
 * answer it, a secret the answer must carry, and the app's name, site and what it asks to sign.
 */
function nostrconnectUri(appPubkey: string, secret: string, relay: string): string {
  const params = new URLSearchParams({
    relay,
    secret,
    name: config.appName,
    url: `https://${config.domain}`,
    perms: PERMISSIONS.join(","),
  });
  return `nostrconnect://${appPubkey}?${params.toString()}`;
}

/**
 * The signal of one attempt to connect: it aborts when `signal` does, after `ms` with a TimeoutError,
 * or at `end`, which stops the clock, so that nothing the attempt opened outlives it.
 */
function attempt(signal: AbortSignal, ms: number): { signal: AbortSignal; end(): void } {
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DOMException("The other side did not answer in time", "TimeoutError")), ms);
  return {
    signal: AbortSignal.any([signal, clock.signal]),
    end() {
      clearTimeout(timer);
      clock.abort(new DOMException("Connecting is over", "AbortError"));
    },
  };
}

/**
 * `relay`, with every request and publish made through it ended when `signal` aborts. NConnectSigner
 * takes no signal of its own for connecting, so this is how a connection that hangs is stopped.
 */
function boundTo(relay: NRelay, signal: AbortSignal): NRelay {
  const both = (other: AbortSignal | undefined) => (other === undefined ? signal : AbortSignal.any([signal, other]));
  return {
    req: (filters, opts) => relay.req(filters, { ...opts, signal: both(opts?.signal) }),
    event: (event, opts) => relay.event(event, { ...opts, signal: both(opts?.signal) }),
    query: (filters, opts) => relay.query(filters, { ...opts, signal: both(opts?.signal) }),
    close: () => relay.close(),
  };
}

/**
 * The relay at `url`, opened only when it is first used, and closed by `close`. A session restored
 * on a reload opens no socket until the person asks their phone app for something.
 */
function openedOnUse(url: string, relays: RelayFor): { relay: NRelay; close(): void } {
  let opened: NRelay | undefined;
  const open = () => (opened ??= relays(url));
  return {
    relay: {
      req: (filters, opts) => open().req(filters, opts),
      event: (event, opts) => open().event(event, opts),
      query: (filters, opts) => open().query(filters, opts),
      close: async () => opened?.close(),
    },
    close() {
      void opened?.close().catch(() => {});
      opened = undefined;
    },
  };
}

/** The signer that asks the phone app at `signerPubkey`, over `relay`, with the app's own key `local`. */
function phoneSigner(relay: NRelay, signerPubkey: string, local: NostrSigner, close: () => void): NostrSigner {
  const signer = new NConnectSigner({ relay, pubkey: signerPubkey, signer: local, timeout: REQUEST_TIMEOUT_MS });
  closers.set(signer, close);
  return signer;
}

/**
 * Whether `event` is an answer to the app's key that carries `secret`, read with the app's own key.
 * NIP-46 encrypts with NIP-44, and some phone apps still answer in NIP-04, whose text ends in
 * `?iv=<iv>`, which NIP-44's base64 cannot hold: the encryption is told from that, as NConnectSigner
 * does. Either way it is the secret that decides.
 */
async function carriesSecret(local: NSecSigner, event: NostrEvent, secret: string): Promise<boolean> {
  try {
    const scheme = event.content.includes("?iv=") ? local.nip04 : local.nip44;
    const answer: unknown = JSON.parse(await scheme.decrypt(event.pubkey, event.content));
    return typeof answer === "object" && answer !== null && (answer as { result?: unknown }).result === secret;
  } catch {
    // Not encrypted to the app, not JSON: not the answer.
    return false;
  }
}

/**
 * The key of the phone app that answers the nostrconnect link: the first answer to `appPubkey` on
 * `relay` that carries `secret`, in NIP-44 or NIP-04. Anything else is passed over: an answer with
 * another secret, or "ack", which anyone who saw the app's key could send. The request is open from the moment this is called
 * (the code is shown after it), and closed when it returns or `signal` aborts.
 */
async function connectAnswer(relay: NRelay, local: NSecSigner, appPubkey: string, secret: string, signal: AbortSignal): Promise<string> {
  const filter: NostrFilter = { kinds: [CONNECT_KIND], "#p": [appPubkey] };
  for await (const msg of relay.req([filter], { signal })) {
    if (msg[0] === "CLOSED") break;
    if (msg[0] !== "EVENT") continue;
    const event = msg[2];
    const toApp = event.tags.some((tag) => tag[0] === "p" && tag[1] === appPubkey);
    if (event.kind !== CONNECT_KIND || !toApp || !isHex64(event.pubkey)) continue;
    if (await carriesSecret(local, event, secret)) return event.pubkey;
  }
  signal.throwIfAborted();
  throw new Error("The meeting point ended the request before the phone app answered");
}

/**
 * Finishes connecting to the phone app at `signerPubkey`: sends `connect` first when the link was the
 * phone app's (a bunker link: `bunker` holds its secret, if it has one), then asks who the person is,
 * all within `signal`. Keeps the session for the tab and gives the account, whose signer asks the
 * phone app over `relay` from now on.
 */
async function finish({
  relay,
  url,
  appKey,
  signerPubkey,
  bunker,
  signal,
}: {
  relay: NRelay;
  url: string;
  appKey: Uint8Array;
  signerPubkey: string;
  /** For a bunker link. After a nostrconnect answer there is none: the answer was the connection. */
  bunker?: { secret: string | undefined };
  signal: AbortSignal;
}): Promise<Account> {
  const local = new NSecSigner(appKey);
  const connecting = new NConnectSigner({ relay: boundTo(relay, signal), pubkey: signerPubkey, signer: local });
  if (bunker !== undefined) await connecting.connect(bunker.secret);
  const pubkey = await connecting.getPublicKey();
  signal.throwIfAborted();

  const session: Session = { how: "phone", pubkey, signerPubkey, relay: url, appKey: bytesToHex(appKey) };
  saveSession(session);
  return { pubkey, how: "phone", signer: phoneSigner(relay, signerPubkey, local, () => void relay.close().catch(() => {})) };
}

/**
 * Connects an app on the person's phone by the nostrconnect link the app shows (`onLink`), as a code
 * to scan and a link to copy. It is taken once the phone app answers with the link's secret, and the
 * person is the one it then says. Gives up after `CONNECT_TIMEOUT_MS`, or when `signal` aborts, with
 * the request on the meeting point closed. `relays` gives the meeting point (tests pass their own).
 */
export async function connectPhone({
  onLink,
  signal,
  relays = openRelay,
}: {
  onLink(uri: string): void;
  signal: AbortSignal;
  relays?: RelayFor;
}): Promise<Account> {
  signal.throwIfAborted();
  // A key for this connection alone: the phone app knows the app by it. It is not the person's.
  const appKey = generateSecretKey();
  const local = new NSecSigner(appKey);
  const appPubkey = await local.getPublicKey();
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  signal.throwIfAborted();

  const url = config.connectRelay;
  const relay = relays(url);
  const limit = attempt(signal, CONNECT_TIMEOUT_MS);
  try {
    const answer = connectAnswer(relay, local, appPubkey, secret, limit.signal);
    // It is awaited below; this hears its end if something before that throws, and `end` stops it.
    answer.catch(() => {});
    onLink(nostrconnectUri(appPubkey, secret, url));
    const signerPubkey = await answer;
    return await finish({ relay, url, appKey, signerPubkey, signal: limit.signal });
  } catch (error) {
    void relay.close().catch(() => {});
    throw error;
  } finally {
    limit.end();
  }
}

/** The phone app's key, where to meet it and its secret, from a bunker link; throws if it is not one to use. */
function readBunkerLink(text: string): { signerPubkey: string; url: string; secret: string | undefined } {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    throw new Error("Not a link");
  }
  if (link.protocol !== "bunker:") throw new Error("Not a bunker link");
  const signerPubkey = (link.hostname || link.pathname.replace(/^\/\//, "")).toLowerCase();
  if (!isHex64(signerPubkey)) throw new Error("The link names no phone app");
  // Only a public wss:// meeting point: a link is the person's to paste, and anyone's to write.
  const url = link.searchParams
    .getAll("relay")
    .map(publicRelayAddress)
    .find((address) => address !== null);
  if (url === undefined) throw new Error("The link names no meeting point the app can use");
  return { signerPubkey, url, secret: link.searchParams.get("secret") ?? undefined };
}

/**
 * Connects the phone app that gave the person `uri`, a bunker link they paste: `connect` with its
 * secret, then who the person is. Refused, with nothing opened, when the link is not one or names no
 * public wss:// meeting point. Gives up as `connectPhone` does.
 */
export async function connectBunker(uri: string, signal: AbortSignal, relays: RelayFor = openRelay): Promise<Account> {
  signal.throwIfAborted();
  const { signerPubkey, url, secret } = readBunkerLink(uri);
  const relay = relays(url);
  const limit = attempt(signal, CONNECT_TIMEOUT_MS);
  try {
    return await finish({ relay, url, appKey: generateSecretKey(), signerPubkey, bunker: { secret }, signal: limit.signal });
  } catch (error) {
    void relay.close().catch(() => {});
    throw error;
  } finally {
    limit.end();
  }
}

/**
 * Signs in with the add-on in this browser (NIP-07): asks it once who the person is, and keeps that
 * for the tab. The add-on may ask the person first; it is given up as `connectPhone` is.
 */
export async function connectBrowser(signal: AbortSignal): Promise<Account> {
  signal.throwIfAborted();
  const limit = attempt(signal, CONNECT_TIMEOUT_MS);
  try {
    const signer = new NBrowserSigner();
    const pubkey = await abortable(signer.getPublicKey(), limit.signal);
    if (!isHex64(pubkey)) throw new Error("The add-on did not say who the person is");
    saveSession({ how: "browser", pubkey });
    return { pubkey, how: "browser", signer };
  } finally {
    limit.end();
  }
}

/**
 * The account of a session this tab kept, as it was, asking nothing: a reload does not ask the add-on
 * again (which may ask the person) or show a new code. Whether the add-on still signs as the person
 * is checked when it first signs (src/account/AccountProvider.tsx). A phone's meeting point is
 * opened when the phone app is first asked for something.
 */
export function restoreAccount(session: Session, relays: RelayFor = openRelay): Account {
  if (session.how === "browser") return { pubkey: session.pubkey, how: "browser", signer: new NBrowserSigner() };
  const { relay, close } = openedOnUse(session.relay, relays);
  const local = new NSecSigner(hexToBytes(session.appKey));
  return { pubkey: session.pubkey, how: "phone", signer: phoneSigner(relay, session.signerPubkey, local, close) };
}

/** Closes what the account's signer holds open: the phone app's meeting point. A browser's has none. */
export function disconnect(account: Account): void {
  closers.get(account.signer)?.();
  closers.delete(account.signer);
}
