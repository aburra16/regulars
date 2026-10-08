import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { config } from "../src/config";

// The site's icons, and the house's badge, are all made from the house's logo by tools/house-icons.sh.

const root = process.cwd();
const at = (path: string) => resolve(root, path);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The width and height in a PNG's header: its first chunk, IHDR, right after the signature. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(at(path));
  expect([...bytes.subarray(0, 8)], `${path} is a PNG`).toEqual(PNG_SIGNATURE);
  expect(bytes.toString("ascii", 12, 16), `${path} starts with its header`).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const indexHtml = new DOMParser().parseFromString(readFileSync(at("index.html"), "utf8"), "text/html");

/** The page's ground in the design tokens: white. */
const ground = /^\s*--ground:\s*(#[0-9a-fA-F]{6});/m.exec(readFileSync(at("handoff/design/tokens.css"), "utf8"))?.[1];

/** A path on the site, as a file in public/, which Vite serves at the site's root as it is. */
const publicFile = (href: string) => at(`public${href}`);

/** A local path of the site: one slash, then not a second (that would be another site, "//cdn..."). */
const LOCAL = /^\/(?!\/)/;

interface Manifest {
  name?: unknown;
  icons?: Array<{ src: string; sizes: string; type: string }>;
  theme_color?: unknown;
  background_color?: unknown;
}

const manifest = (): Manifest => JSON.parse(readFileSync(at("public/site.webmanifest"), "utf8")) as Manifest;

describe("the site's icons", () => {
  it.each([
    ["public/favicon-32.png", 32],
    ["public/apple-touch-icon.png", 180],
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
  ])("%s is a PNG %i px square", (path, px) => {
    expect(pngSize(path)).toEqual({ width: px, height: px });
  });

  it("index.html names the 32 px icon and the apple-touch icon, and no longer the empty icon", () => {
    const icons = [...indexHtml.querySelectorAll('link[rel="icon"]')];
    expect(icons.map((icon) => [icon.getAttribute("type"), icon.getAttribute("sizes"), icon.getAttribute("href")])).toEqual([
      ["image/png", "32x32", "/favicon-32.png"],
    ]);
    const touch = [...indexHtml.querySelectorAll('link[rel="apple-touch-icon"]')];
    expect(touch.map((icon) => icon.getAttribute("href"))).toEqual(["/apple-touch-icon.png"]);
    expect(readFileSync(at("index.html"), "utf8")).not.toContain("data:,");
  });

  it("index.html links the manifest", () => {
    const links = [...indexHtml.querySelectorAll('link[rel="manifest"]')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/site.webmanifest"]);
  });

  it("index.html gives the browser the page's ground as its theme colour", () => {
    expect(ground).toBe("#FFFFFF");
    const metas = [...indexHtml.querySelectorAll('meta[name="theme-color"]')];
    expect(metas.map((meta) => meta.getAttribute("content"))).toEqual([ground]);
  });

  it("index.html links only files of the site itself, each of them in public/", () => {
    const links = [...indexHtml.querySelectorAll("link")];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href, link.outerHTML).toMatch(LOCAL);
      expect(existsSync(publicFile(href)), `public${href}`).toBe(true);
    }
  });
});

describe("site.webmanifest", () => {
  it("is JSON, named for the app", () => {
    expect(manifest().name).toBe(config.appName);
  });

  it("lists the 192 px and 512 px icons, each a PNG of the site of the size it says", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map(({ src, sizes, type }) => [src, sizes, type])).toEqual([
      ["/icon-192.png", "192x192", "image/png"],
      ["/icon-512.png", "512x512", "image/png"],
    ]);
    for (const { src, sizes } of icons) {
      expect(src).toMatch(LOCAL);
      const { width, height } = pngSize(`public${src}`);
      expect(`${width}x${height}`).toBe(sizes);
    }
  });

  it("takes its colours from the page's ground", () => {
    expect(manifest().theme_color).toBe(ground);
    expect(manifest().background_color).toBe(ground);
  });

  it("names no file the site does not have, and nothing on another site", () => {
    const text = readFileSync(at("public/site.webmanifest"), "utf8");
    expect(text).not.toMatch(/\/\/|https?:/);
    const paths = [...text.matchAll(/"(\/[^"]*)"/g)].map(([, path]) => path!);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(publicFile(path)), `public${path}`).toBe(true);
  });
});

describe("the house's badge", () => {
  it("is made from the house's logo, 1024 px square", () => {
    expect(pngSize("src/assets/house/mise-en-place.png")).toEqual({ width: 1024, height: 1024 });
  });

  it.each([
    ["src/assets/house/house-64.png", 64],
    ["src/assets/house/house-96.png", 96],
  ])("%s is a PNG %i px square", (path, px) => {
    expect(pngSize(path)).toEqual({ width: px, height: px });
  });
});
