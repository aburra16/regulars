/*
 * The site's Content Security Policy: a Vite plugin that writes it into the built index.html as a
 * <meta http-equiv>, since GitHub Pages sets no headers. It allows what the app reaches and nothing
 * else, and the scripts written into the page by the hash of each, which the build works out from the
 * page it writes, so a change to the theme's script in index.html changes its hash with it.
 * tests/csp.test.ts builds the site and checks the hash against the script, and checks that every
 * address the code reaches is allowed.
 *
 * A policy in a meta tag cannot set frame-ancestors, report-uri or sandbox: browsers ignore them there.
 * Only a header could keep the site out of other sites' frames. Nor does it reach MapLibre's worker,
 * which takes its policy from the headers its own file is served with.
 *
 * The development server has none: Vite's client and React's refresh run scripts written into the page.
 */
import { createHash } from "node:crypto";

import type { Plugin } from "vite";

/** The policy's directives, each with what it allows. The build adds the scripts' hashes to `script-src`. */
export const CSP_DIRECTIVES = {
  // Anything not named below: nothing.
  "default-src": ["'none'"],
  // The app's own files, and the theme's script in index.html by its hash. No eval: nothing needs it.
  // And the scripts of the browser's sign-in add-ons (NIP-07: nos2x, Alby and others), which put
  // window.nostr on the page with a <script src> of their own, served from these schemes: only an add-on
  // the person has installed serves from them, so no site can. An add-on that writes its code into the
  // page as a script's text cannot be let in: that takes 'unsafe-inline', which a browser ignores beside
  // a hash, and which without the hash would let in any script written into the page. Where the policy
  // blocks one, the sign-in says so in the console (src/signin/addOn.ts, `watchForBlockedAddOn`).
  "script-src": ["'self'", "chrome-extension:", "moz-extension:", "safari-web-extension:"],
  // The app's own stylesheets, and styles written into the page ('unsafe-inline'). Today nothing in the
  // app needs them: React and MapLibre set styles through the DOM's style object, which a policy does
  // not govern. But a style attribute or element a library writes later would break in production
  // alone: jsdom has no policy, so no test would see it. A style does little harm beside scripts that
  // run only from the site's files and the theme's hash, so styles are let in and scripts are not.
  "style-src": ["'self'", "'unsafe-inline'"],
  // The house's pictures, the kinds' icons and MapLibre's controls (some as data: addresses),
  // MapLibre's images where the browser cannot decode them itself (blob:), and reviewers' pictures,
  // which come from any https site they name (src/nostr/profiles.ts takes no other).
  "img-src": ["'self'", "data:", "blob:", "https:"],
  // The fonts are the app's own files (Fontsource's). data: for a font small enough that Vite writes it into the stylesheet.
  "font-src": ["'self'", "data:"],
  // MapTiler's styles, sprites and fonts; Brainstorm's API (My circle); and relays. A review goes to
  // the relays the person writes to, which can be any wss host (src/account/writeRelays.ts takes no
  // ws:), and reads go to several. 'self' for the module preloads Vite fetches in older browsers.
  "connect-src": ["'self'", "https://api.maptiler.com", "https://api.brainstorm.world", "wss:"],
  // MapLibre's worker, a file of the app's own (src/map/maplibre.ts). MapLibre makes a blob: worker
  // only for a worker file on another site.
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
} as const satisfies Record<string, readonly string[]>;

/** The policy as a meta tag writes it, with `scriptHashes` added to `script-src`. */
export function policyText(scriptHashes: readonly string[]): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, sources]) => [name, ...sources, ...(name === "script-src" ? scriptHashes : [])].join(" "))
    .join("; ");
}

/**
 * The hash of each script written into `html` (a script element with no `src`), as CSP names it. A
 * browser hashes a script's text as it reads it, with each CR LF or lone CR read as a line feed.
 */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes ?? ""))
    .map(([, , text]) => {
      const digest = createHash("sha256")
        .update((text ?? "").replace(/\r\n?/g, "\n"), "utf8")
        .digest("base64");
      return `'sha256-${digest}'`;
    });
}

/** The page's character set, which the policy goes after: it must come first, in the first 1,024 bytes. */
const CHARSET = /<meta\s+charset=[^>]*>/i;

/**
 * The plugin: in the build, it puts the policy in index.html's head, after the character set and
 * before anything the page loads or runs. It fails the build when the page has no character set to
 * put it after.
 */
export function contentSecurityPolicy(): Plugin {
  return {
    name: "regulars-content-security-policy",
    apply: "build",
    transformIndexHtml: {
      // After Vite has written its own tags into the page, so the hashes are of the page as it is served.
      order: "post",
      handler(html) {
        const charset = CHARSET.exec(html);
        if (charset === null) throw new Error("index.html has no <meta charset>, which the Content Security Policy goes after");
        const end = charset.index + charset[0].length;
        const meta = `\n    <meta http-equiv="Content-Security-Policy" content="${policyText(inlineScriptHashes(html))}" />`;
        return html.slice(0, end) + meta + html.slice(end);
      },
    },
  };
}
