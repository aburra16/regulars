// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { build } from "vite";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { MAPTILER_DARK_STYLE_URL, MAPTILER_STYLE_URL } from "../src/map/style";
import { CSP_DIRECTIVES } from "../tools/csp";

// The site's Content Security Policy is a <meta http-equiv> in the built index.html (GitHub Pages sets
// no headers), written by the build with the hash of the theme's script in its head (tools/csp.ts).
// The first part builds the real vite.config.ts and index.html in memory, as `npm run build` does,
// and checks the meta against the page. The second reads the code for the addresses it reaches, and
// checks the policy lets it reach each one. The last checks what would break under the policy without
// failing a test in jsdom, which has none: zod's try of eval.
const ROOT = process.cwd();

type Output = Awaited<ReturnType<typeof build>>;

function filesOf(result: Output): { fileName: string; source?: unknown }[] {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap((r) => ("output" in r ? r.output : []));
}

/** The policy in `html`'s meta, as its directives by name; undefined when the page has none. */
function policyOf(html: string): Map<string, string[]> | undefined {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i.exec(html);
  if (meta === null) return undefined;
  const directives = new Map<string, string[]>();
  for (const part of meta[1]!.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/**
 * The text of each script written into `html`: the script elements with no `src`. Their text is
 * what a browser hashes, after it has read a CR LF or a lone CR as a line feed.
 */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes ?? ""))
    .map(([, , text]) => (text ?? "").replace(/\r\n?/g, "\n"));
}

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("the policy in the built page", () => {
  let html = "";

  beforeAll(async () => {
    const files = filesOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false },
      }),
    );
    const page = files.find((file) => file.fileName === "index.html");
    html = typeof page?.source === "string" ? page.source : new TextDecoder().decode(page?.source as Uint8Array);
  }, 60_000);

  it("is in the head, before every script, stylesheet and link", () => {
    expect(policyOf(html)).toBeDefined();
    const meta = html.search(/<meta\s+http-equiv="Content-Security-Policy"/i);
    const head = html.slice(0, html.search(/<\/head>/i));
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(head.length);
    for (const tag of [/<script\b/i, /<link\b/i, /<style\b/i]) {
      const at = html.search(tag);
      if (at !== -1) expect(meta).toBeLessThan(at);
    }
    // One policy: a second would be enforced too, and a page only ever gets stricter.
    expect(html.match(/http-equiv="Content-Security-Policy"/gi)).toHaveLength(1);
  });

  it("lets in the theme's script by its hash, and no other script written into the page", () => {
    const scripts = inlineScripts(html);
    // The theme's, before the first paint (index.html).
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("regulars.theme");
    const scriptSrc = policyOf(html)!.get("script-src") ?? [];
    expect(scriptSrc.filter((source) => source.startsWith("'sha256-"))).toEqual(scripts.map(sha256));
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("lets in the scripts of the browser's sign-in add-ons, from the schemes only an installed add-on serves", () => {
    // NIP-07 add-ons put window.nostr on the page with a script of their own (nos2x, Alby and others).
    const scriptSrc = policyOf(html)!.get("script-src") ?? [];
    for (const scheme of ["chrome-extension:", "moz-extension:", "safari-web-extension:"]) expect(scriptSrc).toContain(scheme);
    // And no scheme any site could serve from.
    for (const scheme of ["https:", "http:", "data:", "blob:", "*"]) expect(scriptSrc).not.toContain(scheme);
  });

  it("lets in no eval, in any directive", () => {
    const written = policyOf(html)!;
    expect([...written].filter(([, sources]) => sources.includes("'unsafe-eval'")).map(([name]) => name)).toEqual([]);
  });

  it("lets in styles written into the page, and scripts only by their hash", () => {
    // A style a library writes into the page would otherwise break in production alone, where a test
    // in jsdom, which has no policy, cannot see it; a style does little harm beside strict scripts.
    expect(policyOf(html)!.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policyOf(html)!.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("is the policy of tools/csp.ts, with the hash added", () => {
    const written = policyOf(html)!;
    expect([...written.keys()]).toEqual(Object.keys(CSP_DIRECTIVES));
    for (const [name, sources] of Object.entries(CSP_DIRECTIVES)) {
      const hashes = name === "script-src" ? inlineScripts(html).map(sha256) : [];
      expect(written.get(name), name).toEqual([...sources, ...hashes]);
    }
  });

  it("sets nothing a meta tag cannot", () => {
    for (const name of ["frame-ancestors", "report-uri", "report-to", "sandbox"]) {
      expect(policyOf(html)!.has(name), name).toBe(false);
    }
  });
});

// ---- The addresses the code reaches ----

/** Whether CSP's `sources` (one directive's) allow `url`, an address on another site than this one. */
function allows(sources: readonly string[], url: string): boolean {
  const target = new URL(url);
  return sources.some((source) => {
    // A scheme: "wss:" allows any address of it.
    if (/^[a-z][a-z\d+.-]*:$/i.test(source)) return target.protocol === source.toLowerCase();
    // A host, with its scheme: "https://api.maptiler.com", or "https://*.example.com", and any path under one given.
    const host = /^([a-z][a-z\d+.-]*):\/\/(\*\.)?([^/:]+)(\/.*)?$/i.exec(source);
    if (host === null) return false;
    const [, scheme, wildcard, name, path] = host;
    if (target.protocol !== `${scheme!.toLowerCase()}:`) return false;
    const hostMatches = wildcard ? target.hostname.endsWith(`.${name!.toLowerCase()}`) : target.hostname === name!.toLowerCase();
    if (!hostMatches) return false;
    if (path === undefined || path === "/") return true;
    return path.endsWith("/") ? target.pathname.startsWith(path) : target.pathname === path;
  });
}

/** Every file of the app's code and styles under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The http, https, ws and wss addresses written in the code, outside comments: in quotes, in a
 * template, or in a stylesheet's `url()`. A template's address is as written, `${…}` and all.
 */
function addressesIn(text: string): string[] {
  const code = text
    // Block comments, and line comments: a `//` that does not follow a colon, as an address's does.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const quoted = [...code.matchAll(/["'`]((?:https?|wss?):\/\/[^"'`\s]*)/g)];
  const inStyles = [...code.matchAll(/url\(\s*((?:https?|wss?):\/\/[^"'`\s)]*)/g)];
  return [...quoted, ...inStyles].map((match) => match[1]!);
}

/**
 * The addresses in the code that the app never fetches or connects to, which CSP does not govern: the
 * pages a person opens from a link, and the app's own address, which it names to a phone's signer.
 */
const NOT_REACHED: ReadonlyArray<readonly [file: string, address: string]> = [
  ["src/about/AboutPage.tsx", "https://www.openstreetmap.org/copyright"],
  ["src/about/AboutPage.tsx", "https://creativecommons.org/licenses/by/4.0/"],
  ["src/account/connect.ts", "https://${config.domain}"],
  ["src/place/Actions.tsx", "https://${website}"],
  ["src/place/osmLinks.ts", "https://www.openstreetmap.org"],
  ["src/place/osmLinks.ts", "https://www.google.com/maps/dir/?api=1&destination=${place.lat.toFixed(6)},${place.lon.toFixed(6)}"],
  ["src/ui/Attribution.tsx", "https://www.maptiler.com/copyright/"],
  ["src/ui/Attribution.tsx", "https://www.openstreetmap.org/copyright"],
];

describe("the policy and the addresses the code reaches", () => {
  const found = sourceFiles(resolve(ROOT, "src")).flatMap((path) =>
    addressesIn(readFileSync(path, "utf8")).map((address) => [relative(ROOT, path).split("\\").join("/"), address] as const),
  );
  const notReached = new Set(NOT_REACHED.map(([file, address]) => `${file} ${address}`));
  const reached = found.filter(([file, address]) => !notReached.has(`${file} ${address}`));

  it("finds the addresses in the code: the relays, Brainstorm and MapTiler", () => {
    const hosts = new Set(reached.map(([, address]) => new URL(address).host));
    for (const host of ["dcosl.brainstorm.world", "search.brainstorm.world", "api.brainstorm.world", "api.maptiler.com", "nos.lol"]) {
      expect(hosts, host).toContain(host);
    }
  });

  it("lets the page connect to every address the code reaches", () => {
    const connect = CSP_DIRECTIVES["connect-src"];
    const refused = reached.filter(([, address]) => !allows(connect, address));
    expect(refused).toEqual([]);
  });

  it("lists only addresses the code still has as never reached", () => {
    const written = new Set(found.map(([file, address]) => `${file} ${address}`));
    expect([...notReached].filter((entry) => !written.has(entry))).toEqual([]);
  });

  it("lets the page reach the relays, Brainstorm and the map's style as the config and the map have them", () => {
    const connect = CSP_DIRECTIVES["connect-src"];
    const addresses = [
      config.placesRelay,
      config.connectRelay,
      ...config.relayListRelays,
      ...config.houseTrustRelays,
      ...Object.keys(config.relayReadExtras),
      config.brainstormApi,
      MAPTILER_STYLE_URL,
      MAPTILER_DARK_STYLE_URL,
    ];
    expect(addresses.filter((address) => !allows(connect, address))).toEqual([]);
  });

  it("lets in any relay a person writes to, and only over wss", () => {
    const connect = CSP_DIRECTIVES["connect-src"];
    expect(allows(connect, "wss://relay.example.com")).toBe(true);
    expect(allows(connect, "ws://relay.example.com")).toBe(false);
    expect(allows(connect, "https://example.com/anything")).toBe(false);
  });

  it("shows reviewers' pictures from any https site, and MapTiler's", () => {
    const img = CSP_DIRECTIVES["img-src"];
    expect(allows(img, "https://pictures.example.com/me.jpg")).toBe(true);
    expect(allows(img, "https://api.maptiler.com/maps/dataviz-light/sprite.png")).toBe(true);
    expect(allows(img, "http://pictures.example.com/me.jpg")).toBe(false);
  });
});

// ---- Nostrify's checks under the policy ----

describe("zod, which Nostrify checks what relays send with", () => {
  it("is told not to try eval, which the policy refuses, before Nostrify checks a message", async () => {
    // zod compiles a check with `new Function` where it can, and tries first whether it can. Under the
    // policy that try is reported as a violation, though zod catches what it throws.
    const tried = vi.spyOn(globalThis, "Function");
    try {
      await import("../src/nostr/relayReader");
      const { NSchema } = await import("@nostrify/nostrify");
      const event = { id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1, kind: 1, tags: [], content: "", sig: "c".repeat(128) };
      expect(NSchema.relayMsg().safeParse(["EVENT", "sub", event]).success).toBe(true);
      expect(tried).not.toHaveBeenCalled();
    } finally {
      tried.mockRestore();
    }
  });

  it("is told so by each module that loads Nostrify", () => {
    const loading = sourceFiles(resolve(ROOT, "src")).filter((path) =>
      /^import\s+(?!type\b)[^;]*from\s+"@nostrify\/nostrify"/m.test(readFileSync(path, "utf8")),
    );
    expect(loading.length).toBeGreaterThan(0);
    for (const path of loading) {
      expect(readFileSync(path, "utf8"), relative(ROOT, path)).toMatch(/^import\s+"(?:\.\/|\.\.\/nostr\/)zod\.ts";$/m);
    }
  });
});
