import { inspect } from "node:util";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountChanged, AccountProvider, useAccount } from "../src/account/AccountProvider";
import { CONNECT_TIMEOUT_MS, connectBunker, connectPhone, restoreAccount } from "../src/account/connect";
import { readSession, SESSION_KEY } from "../src/account/session";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { QrCode } from "../src/signin/QrCode";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { createSignerApp, MemoryConnectRelay } from "./support/connectRelay";
import { shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;

// What Continue opens is a chunk of its own. `broken` makes fetching it fail, as on a flaky network
// or after a deploy that removed the old chunk, until a test mends it.
const choiceChunk = vi.hoisted(() => ({ broken: false }));
vi.mock("../src/signin/loadChooseHow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/loadChooseHow")>();
  return {
    loadChooseHow: () =>
      choiceChunk.broken ? Promise.reject(new TypeError("Failed to fetch dynamically imported module")) : actual.loadChooseHow(),
  };
});

/** The NIP-46 meeting point the app shows in its link (config.connectRelay). */
const MEETING = "wss://relay.nsec.app";
/** A review relay, where names are read from. */
const REVIEWS = "wss://reviews.example.test";

/** What the app asks a signer app to let it do, as the link says it. */
const PERMS = "get_public_key%2Csign_event%3A34259%2Csign_event%3A5%2Csign_event%3A10002";
const LINK = new RegExp(
  `^nostrconnect://([0-9a-f]{64})\\?relay=wss%3A%2F%2Frelay\\.nsec\\.app&secret=([0-9a-f]{32})&name=Regulars&url=https%3A%2F%2Faskregulars\\.world&perms=${PERMS}$`,
);

/** A review as the app will ask for one to be signed (Task 6). */
const template = () => ({ kind: 34259, content: "", tags: [["m", "place"]], created_at: 1_700_000_000 });

/** The app's public key in a nostrconnect link. */
const appPubkeyIn = (uri: string) => LINK.exec(uri)?.[1];

/** A phone connection under way: the link it shows, once it is shown, and the account it ends in. */
function connecting(relay: MemoryConnectRelay, signal = new AbortController().signal) {
  let shown!: (uri: string) => void;
  const link = new Promise<string>((resolve) => {
    shown = resolve;
  });
  const account = connectPhone({ onLink: shown, signal, relays: () => relay });
  // A test that expects it to fail says so; one that does not would hear of it from the await.
  account.catch(() => {});
  return { link, account };
}

/** Whether `promise` has settled yet. */
function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

/** `pubkey`'s profile (kind 0) named `name`. */
const profileOf = (pubkey: string, name: string) => shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });

/** The readers of the scores store, with `profiles` on the review relay. */
const readersWith = (profiles: NostrEvent[]) => (url: string) => createMemoryReader(url === REVIEWS ? profiles : []);

/** The browser add-on (NIP-07) as a page sees it, signing with `key`. */
function installAddOn(key: Uint8Array) {
  const addOn = {
    getPublicKey: vi.fn(async () => getPublicKey(key)),
    signEvent: vi.fn(async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, key)),
  };
  Object.defineProperty(window, "nostr", { configurable: true, writable: true, value: addOn });
  return addOn;
}

/** What the sign-in page is opened with when a link sent the person there from `pathname`. */
const signinFrom = (pathname: string) => ({
  pathname: "/signin",
  state: { from: { pathname, search: "", hash: "", state: null, key: "abc" } },
});

/** The account the provider gives, as the last render saw it. */
let seen: ReturnType<typeof useAccount> | undefined;
function AccountProbe(): JSX.Element | null {
  seen = useAccount();
  return null;
}

/** The account provider alone, with the probe, as a page under it would see it. */
function renderAccount(relay?: MemoryConnectRelay) {
  return render(
    <AccountProvider relays={relay === undefined ? undefined : () => relay}>
      <AccountProbe />
    </AccountProvider>,
  );
}

/** The person's own session in this tab, as `sessionStorage` keeps it, read as text. */
const sessionText = () => window.sessionStorage.getItem(SESSION_KEY);

beforeEach(() => {
  seen = undefined;
  config.reviewRelays = [REVIEWS];
});

afterEach(() => {
  choiceChunk.broken = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
  config.features.signIn = true;
});

// ---- Connecting an app on a phone (NIP-46) ----

describe("the link the app shows a phone", () => {
  it("names the app's own key for this connection, the meeting point, a fresh secret, the app and what it asks to sign", async () => {
    const relay = new MemoryConnectRelay();
    const controller = new AbortController();
    const first = connecting(relay, controller.signal);
    const uri = await first.link;
    expect(uri).toMatch(LINK);

    // It listens on the meeting point for answers to its key before it shows the link.
    expect(relay.openFilters).toEqual([[{ kinds: [24133], "#p": [appPubkeyIn(uri)] }]]);

    // Each connection has a key and a secret of its own.
    const second = connecting(relay, controller.signal);
    const again = await second.link;
    expect(appPubkeyIn(again)).not.toBe(appPubkeyIn(uri));
    expect(LINK.exec(again)?.[2]).not.toBe(LINK.exec(uri)?.[2]);

    controller.abort();
    await expect(first.account).rejects.toThrow();
    await expect(second.account).rejects.toThrow();
  });

  it("is the meeting point in the config, which is relay.nsec.app", () => {
    expect(config.connectRelay).toBe(MEETING);
    expect(config.features.signIn).toBe(true);
  });
});

describe("the phone's answer", () => {
  it("is taken when it carries the link's secret: the person is who the phone app says, and it signs for them", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const { link, account } = connecting(relay);
    await app.scan(await link);

    const person = await account;
    expect(person.how).toBe("phone");
    // The phone app speaks with a key of its own; the person is the key it signs with (NIP-46).
    expect(person.pubkey).toBe(app.userPubkey);
    expect(person.pubkey).not.toBe(app.remotePubkey);

    const signed = await person.signer.signEvent(template());
    expect(signed.pubkey).toBe(app.userPubkey);
    expect(signed.kind).toBe(34259);
    expect(app.requests).toEqual(["get_public_key", "sign_event"]);
    // Every request is closed once it is answered.
    expect(relay.openSubscriptions).toBe(0);
  });

  it("is taken in NIP-04 too, which some phone apps still answer in, when it carries the link's secret", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay, { encryption: "nip04" });
    const { link, account } = connecting(relay);
    await app.scan(await link);
    const person = await account;
    expect(person.pubkey).toBe(app.userPubkey);
    expect((await person.signer.signEvent(template())).pubkey).toBe(app.userPubkey);
  });

  it("is ignored in NIP-04 as in NIP-44 when it carries another secret", async () => {
    const relay = new MemoryConnectRelay();
    const stranger = createSignerApp(relay, { connectReply: "wrong-secret", encryption: "nip04" });
    const phone = createSignerApp(relay);
    const { link, account } = connecting(relay);
    const uri = await link;
    await stranger.scan(uri);
    await phone.scan(uri);
    expect((await account).pubkey).toBe(phone.userPubkey);
    expect(stranger.requests).toEqual([]);
  });

  it("is ignored when it carries another secret, and the right one is still taken after it", async () => {
    const relay = new MemoryConnectRelay();
    const stranger = createSignerApp(relay, { connectReply: "wrong-secret" });
    const phone = createSignerApp(relay);
    const { link, account } = connecting(relay);
    const uri = await link;

    // The answers are read in the order they come: the stranger's first. Had it been taken, the app
    // would have asked the stranger who the person is, and signed them in as the stranger's person.
    await stranger.scan(uri);
    await phone.scan(uri);
    expect((await account).pubkey).toBe(phone.userPubkey);
    expect(stranger.requests).toEqual([]);
  });

  it("is ignored when it says only 'ack', or cannot be read, which no phone app with the link sends", async () => {
    const relay = new MemoryConnectRelay();
    const acker = createSignerApp(relay, { connectReply: "ack" });
    const phone = createSignerApp(relay);
    const { link, account } = connecting(relay);
    const uri = await link;

    await acker.scan(uri);
    // Something addressed to the app that is not encrypted to it.
    const someone = generateSecretKey();
    await relay.event(
      finalizeEvent({ kind: 24133, created_at: 1_700_000_000, tags: [["p", appPubkeyIn(uri)!]], content: "not for you" }, someone),
    );
    await phone.scan(uri);
    expect((await account).pubkey).toBe(phone.userPubkey);
    expect(acker.requests).toEqual([]);
  });
});

describe("a phone app that never answers, or stops half-way (Review Focus 3)", () => {
  it("gives up after 120 seconds with no answer, and leaves no request open", async () => {
    vi.useFakeTimers();
    const relay = new MemoryConnectRelay();
    const { link, account } = connecting(relay);
    await link;
    const done = settled(account);

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(done()).toBe(false);
    expect(relay.openSubscriptions).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(account).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);
    expect(relay.closed).toBe(1);
    expect(CONNECT_TIMEOUT_MS).toBe(120_000);
  });

  it("gives up when the app connects and then never says who the person is", async () => {
    vi.useFakeTimers();
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay, { getPublicKey: "none" });
    const { link, account } = connecting(relay);
    await app.scan(await link);
    await vi.waitFor(() => expect(app.requests).toEqual(["get_public_key"]));

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await expect(account).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);
    expect(sessionText()).toBeNull();
  });

  it("gives up at once when the person says no on the phone", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay, { getPublicKey: "error" });
    const { link, account } = connecting(relay);
    await app.scan(await link);
    await expect(account).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);
    expect(sessionText()).toBeNull();
  });

  it("stops when it is cancelled, and leaves no request open", async () => {
    const relay = new MemoryConnectRelay();
    const controller = new AbortController();
    const { link, account } = connecting(relay, controller.signal);
    await link;
    expect(relay.openSubscriptions).toBe(1);

    controller.abort();
    await expect(account).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);
    expect(relay.closed).toBe(1);
  });

  it("does not start when it is cancelled already", async () => {
    const relays = vi.fn(() => new MemoryConnectRelay());
    const onLink = vi.fn();
    await expect(connectPhone({ onLink, signal: AbortSignal.abort(), relays })).rejects.toThrow();
    expect(onLink).not.toHaveBeenCalled();
    expect(relays).not.toHaveBeenCalled();
  });
});

describe("a link pasted from the phone app (bunker://)", () => {
  it("connects with the link's secret and asks who the person is", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const relays = vi.fn(() => relay);
    const person = await connectBunker(app.bunkerLink(), new AbortController().signal, relays);
    expect(person.pubkey).toBe(app.userPubkey);
    expect(person.how).toBe("phone");
    expect(app.requests).toEqual(["connect", "get_public_key"]);
    expect(relays).toHaveBeenCalledWith(MEETING);
    expect((await person.signer.signEvent(template())).pubkey).toBe(app.userPubkey);
    expect(relay.openSubscriptions).toBe(0);
  });

  it.each([
    ["a meeting point that is not wss://", "ws://relay.example.com"],
    ["one on this machine", "wss://localhost"],
    ["one on the local network", "wss://192.168.1.20"],
    ["one written with a password", "wss://user:pass@relay.example.com"],
  ])("is refused, with nothing opened, when it names %s", async (_, at) => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const relays = vi.fn(() => relay);
    await expect(connectBunker(app.bunkerLink({ relay: at }), new AbortController().signal, relays)).rejects.toThrow();
    expect(relays).not.toHaveBeenCalled();
  });

  it.each([
    ["not a link", "hello"],
    ["another kind of link", "https://askregulars.world/"],
    ["a nostrconnect link", `nostrconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.nsec.app&secret=x`],
    ["no key", "bunker://?relay=wss://relay.nsec.app"],
    ["a key that is not one", "bunker://npub1abc?relay=wss://relay.nsec.app"],
    ["no meeting point", `bunker://${"a".repeat(64)}?secret=x`],
  ])("is refused, with nothing opened, when it is %s", async (_, uri) => {
    const relays = vi.fn(() => new MemoryConnectRelay());
    await expect(connectBunker(uri, new AbortController().signal, relays)).rejects.toThrow();
    expect(relays).not.toHaveBeenCalled();
  });

  it("is refused when the phone app does not take its secret", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const link = app.bunkerLink({ secret: "right" }).replace("secret=right", "secret=wrong");
    await expect(connectBunker(link, new AbortController().signal, () => relay)).rejects.toThrow();
    expect(app.requests).toEqual(["connect"]);
    expect(relay.openSubscriptions).toBe(0);
  });

  it("gives up after 120 seconds when nothing answers, and when it is cancelled", async () => {
    vi.useFakeTimers();
    const relay = new MemoryConnectRelay();
    const silent = connectBunker(`bunker://${"b".repeat(64)}?relay=wss%3A%2F%2Frelay.nsec.app&secret=x`, new AbortController().signal, () => relay);
    silent.catch(() => {});
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await expect(silent).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);

    const controller = new AbortController();
    const cancelled = connectBunker(`bunker://${"b".repeat(64)}?relay=wss%3A%2F%2Frelay.nsec.app`, controller.signal, () => relay);
    cancelled.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(relay.openSubscriptions).toBe(0);
  });
});

// ---- The session ----

describe("the session", () => {
  it("keeps the app's connection key in this tab's sessionStorage, and never in localStorage, the address or the console", async () => {
    const consoles = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) => vi.spyOn(console, method));
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, relays: () => relay, entries: ["/about", signinFrom("/about")] });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await user.click(await screen.findByRole("button", { name: copy.signin.copyLink }));
    const uri = writeText.mock.calls[0]![0];
    await app.scan(uri);
    await waitFor(() => expect(router.state.location.pathname).toBe("/about"));

    const session = readSession();
    expect(session).toMatchObject({ how: "phone", pubkey: app.userPubkey, signerPubkey: app.remotePubkey, relay: MEETING });
    const key = session?.how === "phone" ? session.appKey : "";
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // It is the key the link was made from: its public half is in the link, and it is not.
    expect(getPublicKey(hexToBytes(key))).toBe(appPubkeyIn(uri));
    expect(uri).not.toContain(key);

    for (let i = 0; i < window.localStorage.length; i += 1) {
      const name = window.localStorage.key(i)!;
      expect(name + (window.localStorage.getItem(name) ?? "")).not.toContain(key);
    }
    expect(JSON.stringify(router.state.location)).not.toContain(key);
    for (const spy of consoles) {
      for (const call of spy.mock.calls) expect(call.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 8 }))).join(" ")).not.toContain(key);
    }
  });

  it("restores a phone session in the same tab with no new scan, and signs through the same phone app", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const { link, account } = connecting(relay);
    await app.scan(await link);
    await account;

    // The page is reloaded: what this tab kept is all there is.
    const restored = restoreAccount(readSession()!, () => relay);
    expect(restored.pubkey).toBe(app.userPubkey);
    expect(restored.how).toBe("phone");
    expect((await restored.signer.signEvent(template())).pubkey).toBe(app.userPubkey);
    expect(app.requests).toEqual(["get_public_key", "sign_event"]);
  });

  it("restores a phone session when the app opens, with no new link shown", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const { link, account } = connecting(relay);
    await app.scan(await link);
    await account;

    await openApp("/you", { events: fixtures, relays: () => relay, readers: readersWith([profileOf(app.userPubkey, "Alice")]) });
    expect(await screen.findByRole("heading", { level: 1, name: "Alice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.you.signOut })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: copy.signin.qrLabel })).not.toBeInTheDocument();
    expect(relay.openSubscriptions).toBe(0);
  });

  it("restores a browser session without asking the add-on again, and checks it at the first signing", async () => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    const addOn = installAddOn(key);
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));

    renderAccount();
    await waitFor(() => expect(seen?.account?.pubkey).toBe(pubkey));
    expect(seen?.account?.how).toBe("browser");
    expect(addOn.getPublicKey).not.toHaveBeenCalled();

    const signed = await seen!.account!.signer.signEvent(template());
    expect(signed.pubkey).toBe(pubkey);
    expect(seen?.account?.pubkey).toBe(pubkey);
  });

  it("signs out, and asks again, when the add-on signs as someone else than the person who signed in", async () => {
    const pubkey = getPublicKey(generateSecretKey());
    installAddOn(generateSecretKey());
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));

    renderAccount();
    await waitFor(() => expect(seen?.account?.pubkey).toBe(pubkey));
    // A typed error, so that the page that asked to sign can send the person to sign in again.
    await expect(seen!.account!.signer.signEvent(template())).rejects.toBeInstanceOf(AccountChanged);
    await waitFor(() => expect(seen?.account).toBeUndefined());
    expect(sessionText()).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["no way of signing", JSON.stringify({ pubkey: "a".repeat(64) })],
    ["a key that is not one", JSON.stringify({ how: "browser", pubkey: "npub1abc" })],
    ["a phone session with no connection key", JSON.stringify({ how: "phone", pubkey: "a".repeat(64), signerPubkey: "b".repeat(64), relay: MEETING })],
    ["a phone session at a meeting point that is not wss://", JSON.stringify({ how: "phone", pubkey: "a".repeat(64), signerPubkey: "b".repeat(64), relay: "ws://relay.example.com", appKey: "c".repeat(64) })],
  ])("starts signed out, and forgets what was kept, when it is %s", async (_, text) => {
    window.sessionStorage.setItem(SESSION_KEY, text);
    renderAccount();
    await waitFor(() => expect(seen?.restoring).toBe(false));
    expect(seen?.account).toBeUndefined();
    expect(sessionText()).toBeNull();
  });
});

// ---- Choosing how to sign in ----

describe("Continue with Nostr", () => {
  it("opens the choice between this browser and an app on the phone, where the browser has an add-on", async () => {
    installAddOn(generateSecretKey());
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));

    const choice = await screen.findByRole("group", { name: copy.signin.chooseLabel });
    expect(within(choice).getAllByRole("button").map((button) => button.textContent)).toEqual([copy.signin.browser, copy.signin.phone]);
    expect(within(choice).getByRole("button", { name: copy.signin.browser })).toHaveFocus();
    expect(screen.queryByText(copy.signin.noAddOn)).not.toBeInTheDocument();
    // The way back and the notice stay.
    expect(screen.getByRole("link", { name: copy.signin.keepHousePicks })).toBeInTheDocument();
    expect(screen.getByText(copy.signin.notice)).toBeInTheDocument();
    expect([copy.signin.browser, copy.signin.phone]).toEqual(["This browser", "An app on your phone"]);
  });

  it("offers only the phone on a phone with no add-on, and no line about add-ons, which phones' browsers seldom take", async () => {
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    const choice = await screen.findByRole("group", { name: copy.signin.chooseLabel });
    expect(within(choice).getAllByRole("button").map((button) => button.textContent)).toEqual([copy.signin.phone]);
    expect(screen.queryByText(copy.signin.noAddOn)).not.toBeInTheDocument();
  });

  it("offers only the phone on a desktop with no add-on, with a line on how to get one", async () => {
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));

    const choice = await screen.findByRole("group", { name: copy.signin.chooseLabel });
    expect(within(choice).getAllByRole("button").map((button) => button.textContent)).toEqual([copy.signin.phone]);
    expect(screen.getByText(copy.signin.noAddOn)).toBeInTheDocument();
  });

  it("says it did not connect when what Continue opens cannot be fetched, and Try again fetches it afresh", async () => {
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, px: DESKTOP });
    choiceChunk.broken = true;
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signin.failed);
    // Not the page's error: the sign-in page is still there, with its way back.
    expect(screen.getByRole("link", { name: copy.signin.keepHousePicks })).toBeInTheDocument();
    expect(screen.queryByText(copy.broken.text)).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: copy.signin.tryAgain });
    expect(retry).toHaveFocus();

    choiceChunk.broken = false;
    await user.click(retry);
    expect(await screen.findByRole("group", { name: copy.signin.chooseLabel })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the sign-in page's notice, now that signing in is open", async () => {
    await openApp("/signin", { events: fixtures });
    expect(screen.getByRole("button", { name: copy.signin.continueButton })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText(copy.signin.notice)).toBeInTheDocument();
    expect(screen.queryByText(copy.signin.comingSoon)).not.toBeInTheDocument();
  });
});

describe("signing in with this browser", () => {
  it("asks the add-on who the person is once, keeps it for the tab, and goes back to where the person was", async () => {
    const key = generateSecretKey();
    const addOn = installAddOn(key);
    const user = userEvent.setup();
    const { router } = await openApp("/signin", {
      events: fixtures,
      px: DESKTOP,
      entries: ["/about", signinFrom("/about")],
      readers: readersWith([profileOf(getPublicKey(key), "Maya")]),
    });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/about"));
    expect(addOn.getPublicKey).toHaveBeenCalledTimes(1);
    expect(readSession()).toEqual({ how: "browser", pubkey: getPublicKey(key) });
    // The page the person came from, with the top bar, which is theirs now.
    expect(await within(await screen.findByRole("banner")).findByRole("link", { name: copy.nav.accountOf("Maya") })).toHaveTextContent("M");
  });

  it("says it did not connect, with Try again, when the add-on says no", async () => {
    const addOn = installAddOn(generateSecretKey());
    addOn.getPublicKey.mockRejectedValueOnce(new Error("The person said no"));
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.browser }));

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signin.failed);
    expect(copy.signin.failed).toBe("That didn't connect. Try again.");
    await user.click(screen.getByRole("button", { name: copy.signin.tryAgain }));
    await waitFor(() => expect(readSession()).toMatchObject({ how: "browser" }));
  });
});

describe("signing in with an app on the phone", () => {
  it("shows a code to scan and a link to copy, and signs in when the phone app answers", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const user = userEvent.setup();
    const { router } = await openApp("/signin", {
      events: fixtures,
      px: DESKTOP,
      relays: () => relay,
      entries: ["/about", signinFrom("/about")],
      readers: readersWith([profileOf(app.userPubkey, "Alice")]),
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));

    expect(await screen.findByRole("img", { name: copy.signin.qrLabel })).toBeInTheDocument();
    expect(screen.getByText(copy.signin.scan)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.signin.paste)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.signin.copyLink }));
    const uri = writeText.mock.calls[0]![0];
    expect(uri).toMatch(LINK);
    expect(await screen.findByText(copy.signin.copied)).toBeInTheDocument();

    // The desktop's person scans the code with their phone: nothing here opens an app.
    expect(screen.queryByRole("link", { name: copy.signin.openApp })).not.toBeInTheDocument();

    await app.scan(uri);
    await waitFor(() => expect(router.state.location.pathname).toBe("/about"));
    expect(await within(await screen.findByRole("banner")).findByRole("link", { name: copy.nav.accountOf("Alice") })).toHaveTextContent("A");
  });

  it("on a phone, has Open the app beside the code, a link to the app on the same phone", async () => {
    const relay = new MemoryConnectRelay();
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, relays: () => relay });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });

    const open = screen.getByRole("link", { name: copy.signin.openApp });
    await user.click(screen.getByRole("button", { name: copy.signin.copyLink }));
    const uri = writeText.mock.calls[0]![0];
    expect(uri).toMatch(LINK);
    expect(open).toHaveAttribute("href", uri);
    expect(copy.signin.openApp).toBe("Open the app");
  });

  it("says so when the browser will not copy the link", async () => {
    const relay = new MemoryConnectRelay();
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, relays: () => relay });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });

    await user.click(screen.getByRole("button", { name: copy.signin.copyLink }));
    expect(await screen.findByText(copy.signin.notCopied)).toBeInTheDocument();
    expect(screen.queryByText(copy.signin.copied)).not.toBeInTheDocument();
  });

  it("signs in with a link pasted from the phone app", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, relays: () => relay, entries: ["/you", signinFrom("/you")] });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));

    await user.click(await screen.findByLabelText(copy.signin.paste));
    await user.paste(app.bunkerLink());
    await user.click(screen.getByRole("button", { name: copy.signin.connect }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/you"));
    expect(readSession()).toMatchObject({ how: "phone", pubkey: app.userPubkey });
    // The request the code was waiting on is closed.
    expect(relay.openSubscriptions).toBe(0);
  });

  it("says it did not connect, with Try again, when nothing answers in 120 seconds (Review Focus 3)", async () => {
    const relay = new MemoryConnectRelay();
    await openApp("/signin", { events: fixtures, relays: () => relay });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });
    const first = relay.openFilters;
    expect(first).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't connect. Try again.");
    expect(screen.queryByRole("img", { name: copy.signin.qrLabel })).not.toBeInTheDocument();
    expect(relay.openSubscriptions).toBe(0);

    // Try again starts afresh, with a new link.
    await user.click(screen.getByRole("button", { name: copy.signin.tryAgain }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });
    await waitFor(() => expect(relay.openSubscriptions).toBe(1));
    expect(relay.openFilters).not.toEqual(first);
  });

  it("says it did not connect when the phone app stops half-way", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay, { getPublicKey: "error" });
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, relays: () => relay });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await user.click(await screen.findByRole("button", { name: copy.signin.copyLink }));
    await app.scan(writeText.mock.calls[0]![0]);

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signin.failed);
    expect(relay.openSubscriptions).toBe(0);
    expect(sessionText()).toBeNull();
  });

  it("goes back to the choice when it is cancelled, and leaves nothing open", async () => {
    const relay = new MemoryConnectRelay();
    const user = userEvent.setup();
    await openApp("/signin", { events: fixtures, relays: () => relay });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });
    expect(relay.openSubscriptions).toBe(1);

    await user.click(screen.getByRole("button", { name: copy.signin.cancel }));
    expect(screen.getByRole("button", { name: copy.signin.phone })).toHaveFocus();
    expect(screen.queryByRole("img", { name: copy.signin.qrLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(relay.openSubscriptions).toBe(0));
    expect(relay.closed).toBe(1);
  });

  it("leaves nothing open when the person leaves the page while it waits", async () => {
    const relay = new MemoryConnectRelay();
    const user = userEvent.setup();
    const { router } = await openApp("/signin", { events: fixtures, relays: () => relay, entries: ["/about", signinFrom("/about")] });
    await user.click(screen.getByRole("button", { name: copy.signin.continueButton }));
    await user.click(await screen.findByRole("button", { name: copy.signin.phone }));
    await screen.findByRole("img", { name: copy.signin.qrLabel });

    await user.click(screen.getByRole("link", { name: copy.signin.keepHousePicks }));
    expect(router.state.location.pathname).toBe("/about");
    await waitFor(() => expect(relay.openSubscriptions).toBe(0));
  });
});

// ---- Signed in ----

describe("signed in", () => {
  /** The person signed in with this browser in this tab, before the page was opened. */
  function signedInWithBrowser(): string {
    const key = generateSecretKey();
    installAddOn(key);
    const pubkey = getPublicKey(key);
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
    return pubkey;
  }

  it("shows the person's initial on the account button, named by their name, from their profile", async () => {
    const pubkey = signedInWithBrowser();
    await openApp("/about", { events: fixtures, px: DESKTOP, readers: readersWith([profileOf(pubkey, "Sofia")]) });
    expect(copy.nav.accountOf("Sofia")).toBe("Sofia, your account");
    const button = await within(screen.getByRole("banner")).findByRole("link", { name: "Sofia, your account" });
    expect(button).toHaveAttribute("href", "/you");
    expect(button).toHaveTextContent(/^S$/);
  });

  it("names the account button Your account until the person's name is known", async () => {
    signedInWithBrowser();
    await openApp("/", { events: fixtures, readers: readersWith([]) });
    const top = screen.getByRole("banner");
    expect(copy.nav.yourAccount).toBe("Your account");
    expect(await within(top).findByRole("link", { name: copy.nav.yourAccount })).toHaveAttribute("href", "/you");
    expect(within(top).queryByRole("link", { name: copy.nav.account })).not.toBeInTheDocument();
  });

  it("never calls the person Someone, which is what the store says for a profile with no name to show", async () => {
    const pubkey = signedInWithBrowser();
    const npubName = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";
    await openApp("/you", { events: fixtures, px: DESKTOP, readers: readersWith([profileOf(pubkey, npubName)]) });
    expect(await within(screen.getByRole("banner")).findByRole("link", { name: copy.nav.yourAccount })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.nav.you);
    expect(screen.queryByText(copy.reviews.someone)).not.toBeInTheDocument();
    expect(screen.queryByText(npubName)).not.toBeInTheDocument();
  });

  it("sends someone already signed in back to where they came from when they open sign in, with no Continue", async () => {
    signedInWithBrowser();
    const { router } = await openApp("/signin", { events: fixtures, entries: ["/about", signinFrom("/about")] });
    expect(screen.queryByRole("button", { name: copy.signin.continueButton })).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/about"));
  });

  it("sends someone already signed in to You when sign in does not know where they came from", async () => {
    signedInWithBrowser();
    const { router } = await openApp("/signin", { events: fixtures, readers: readersWith([]) });
    expect(screen.queryByRole("button", { name: copy.signin.continueButton })).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/you"));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("has the person's name and Sign out on You, with the dark mode switch still there", async () => {
    const pubkey = signedInWithBrowser();
    await openApp("/you", { events: fixtures, readers: readersWith([profileOf(pubkey, "Sofia")]) });
    expect(await screen.findByRole("heading", { level: 1, name: "Sofia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.you.signOut })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: copy.nav.darkMode })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.signin.button })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe(copy.titles.you));
  });

  it("forgets the session at Sign out, and You asks the person to sign in again", async () => {
    const pubkey = signedInWithBrowser();
    const user = userEvent.setup();
    await openApp("/you", { events: fixtures, px: DESKTOP, readers: readersWith([profileOf(pubkey, "Sofia")]) });
    await user.click(await screen.findByRole("button", { name: copy.you.signOut }));

    expect(sessionText()).toBeNull();
    expect(screen.getByText(copy.you.signedOut)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.signin.button })).toHaveAttribute("href", "/signin");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.account })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("closes the phone app's connection at Sign out", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const { link, account } = connecting(relay);
    await app.scan(await link);
    await account;
    const closedBefore = relay.closed;

    renderAccount(relay);
    await waitFor(() => expect(seen?.account?.how).toBe("phone"));
    // It is used, so its connection is open.
    await seen!.account!.signer.signEvent(template());
    act(() => seen!.signOut());
    expect(seen?.account).toBeUndefined();
    expect(sessionText()).toBeNull();
    await waitFor(() => expect(relay.closed).toBe(closedBefore + 1));
  });

  it("keeps My circle off, reading 'soon', and tapping it goes nowhere", async () => {
    signedInWithBrowser();
    const user = userEvent.setup();
    const { router } = await openApp("/", { events: fixtures, readers: readersWith([]) });
    const toggle = screen.getByRole("group", { name: copy.view.label });
    const circle = within(toggle).getByRole("button", { name: copy.view.circleSoon });
    expect(copy.view.circleSoon).toBe("My circle · soon");
    expect(circle).toBeDisabled();
    await user.click(circle);
    expect(router.state.location.pathname).toBe("/");
    expect(within(toggle).getByRole("button", { name: copy.view.house })).toHaveAttribute("aria-pressed", "true");
  });

  it("has Saved say it is coming, with no way to sign in again", async () => {
    signedInWithBrowser();
    await openApp("/saved", { events: fixtures, readers: readersWith([]) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.pages.saved);
    expect(screen.getByText(copy.saved.soon)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.signin.button })).not.toBeInTheDocument();
  });
});

// ---- The code to scan ----

describe("the code to scan", () => {
  it("has a quiet zone of 4 modules on each side, in modules, whatever size it is drawn at", () => {
    const uri = `nostrconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.nsec.app&secret=${"b".repeat(32)}&name=Regulars&url=https%3A%2F%2Faskregulars.world&perms=get_public_key%2Csign_event%3A34259%2Csign_event%3A5%2Csign_event%3A10002`;
    render(<QrCode text={uri} label="code" />);
    const svg = screen.getByRole("img", { name: "code" });
    const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(" ").map(Number);
    expect(width).toBe(height);
    const size = width!;
    // Every run of dark modules: "M<x> <y>h<length>v1h-<length>z".
    const runs = [...(svg.querySelector("path")?.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)/g)].map(([, x, y, n]) => ({
      x: Number(x),
      y: Number(y),
      end: Number(x) + Number(n),
    }));
    expect(runs.length).toBeGreaterThan(100);
    expect(Math.min(...runs.map((run) => run.x))).toBe(4);
    expect(Math.min(...runs.map((run) => run.y))).toBe(4);
    expect(Math.max(...runs.map((run) => run.end))).toBe(size - 4);
    expect(Math.max(...runs.map((run) => run.y))).toBe(size - 5);
  });
});

// ---- Signers are what the app is given, never keys ----

describe("the account", () => {
  it("has a signer and a public key, and nothing of the person's own key", async () => {
    const relay = new MemoryConnectRelay();
    const app = createSignerApp(relay);
    const { link, account } = connecting(relay);
    await app.scan(await link);
    const person = await account;
    const signer: NostrSigner = person.signer;
    expect(typeof signer.signEvent).toBe("function");
    expect(Object.keys(person).sort()).toEqual(["how", "pubkey", "signer"]);
  });
});
