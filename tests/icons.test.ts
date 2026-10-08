import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { config } from "../src/config";

// The site's icons, and the house's badge, are all made from the house's logo by tools/house-icons.sh.
// The tab icon is made from the logo with its cream ground cleared (tools/transparent-logo.mjs); the
// others keep the ground.

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

type Rgba = [r: number, g: number, b: number, a: number];

/** A PNG's pixels: what tools/house-icons.sh writes, 8 bits a channel, RGB or RGBA, not interlaced. */
interface Png {
  width: number;
  height: number;
  /** 2 for RGB, 6 for RGBA. */
  colourType: number;
  /** The pixel at (x, y), its alpha 255 in a PNG with no alpha channel. */
  at(x: number, y: number): Rgba;
}

const pngs = new Map<string, Png>();

/** Reads a PNG's pixels, once a run: its IDAT chunks inflated, then each line unfiltered (PNG spec, section 9). */
function readPng(path: string): Png {
  const read = pngs.get(path) ?? decodePng(path);
  pngs.set(path, read);
  return read;
}

/** The Paeth predictor (PNG spec, 9.4): of left, up and up-left, the one nearest left + up - up-left. */
function paeth(left: number, up: number, upLeft: number): number {
  const guess = left + up - upLeft;
  const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) => Math.abs(guess - value)) as [number, number, number];
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function decodePng(path: string): Png {
  const bytes = readFileSync(at(path));
  expect([...bytes.subarray(0, 8)], `${path} is a PNG`).toEqual(PNG_SIGNATURE);
  const header = bytes.subarray(16, 29);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [bitDepth, colourType, , , interlace] = header.subarray(8);
  expect({ bitDepth, interlace }, path).toEqual({ bitDepth: 8, interlace: 0 });
  expect([2, 6], `${path} is RGB or RGBA`).toContain(colourType);
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const lines = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = lines[y * (stride + 1)]!;
    expect(filter, `${path}, line ${y}`).toBeLessThanOrEqual(4);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      pixels[y * stride + i] = (lines[y * (stride + 1) + 1 + i]! + predictor) & 0xff;
    }
  }
  return {
    width,
    height,
    colourType: colourType!,
    at(x, y) {
      const i = (y * width + x) * channels;
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, channels === 4 ? pixels[i + 3]! : 255];
    },
  };
}

/** How far apart two colours are: the distance between them in RGB. */
const distance = ([r, g, b]: Rgba, [r2, g2, b2]: Rgba) => Math.hypot(r - r2, g - g2, b - b2);

const corners = (px: number) => [
  [0, 0],
  [px - 1, 0],
  [0, px - 1],
  [px - 1, px - 1],
];

const LOGO = "src/assets/house/mise-en-place.png";
const CLEAR_LOGO = "src/assets/house/mise-en-place-transparent.png";

/** The logo's ground, a flat cream: its top left pixel. */
const cream = (): Rgba => readPng(LOGO).at(0, 0);

/** Where tools/house-icons.sh cuts the tab icon from the logo: an 800 px square, from (112, 120). */
const TAB_CUT = { left: 112, top: 120, size: 800 };

/** The middle of the circle in the pin, in the logo: cream, with the pin's outline all round it. */
const CIRCLE = { x: 512, y: 591 };

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
    ["public/favicon-64.png", 64],
    ["public/apple-touch-icon.png", 180],
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
  ])("%s is a PNG %i px square", (path, px) => {
    expect(pngSize(path)).toEqual({ width: px, height: px });
  });

  it("index.html names the 32 px and 64 px icons and the apple-touch icon, and no longer the empty icon", () => {
    const icons = [...indexHtml.querySelectorAll('link[rel="icon"]')];
    expect(icons.map((icon) => [icon.getAttribute("type"), icon.getAttribute("sizes"), icon.getAttribute("href")])).toEqual([
      ["image/png", "32x32", "/favicon-32.png"],
      ["image/png", "64x64", "/favicon-64.png"],
    ]);
    const touch = [...indexHtml.querySelectorAll('link[rel="apple-touch-icon"]')];
    expect(touch.map((icon) => icon.getAttribute("href"))).toEqual(["/apple-touch-icon.png"]);
    expect(readFileSync(at("index.html"), "utf8")).not.toContain("data:,");
  });

  it("index.html links the manifest", () => {
    const links = [...indexHtml.querySelectorAll('link[rel="manifest"]')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/site.webmanifest"]);
  });

  it("index.html gives the browser the page's ground as its theme colour, on a device in the light", () => {
    expect(ground).toBe("#FFFFFF");
    const metas = [...indexHtml.querySelectorAll('meta[name="theme-color"]')];
    const light = metas.filter((meta) => meta.getAttribute("media") === "(prefers-color-scheme: light)");
    expect(light.map((meta) => meta.getAttribute("content"))).toEqual([ground]);
    // The dark theme's, and the colour of a theme the person chose: tests/theme.test.tsx.
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

describe("the tab icon", () => {
  it.each([
    ["public/favicon-32.png", 32],
    ["public/favicon-64.png", 64],
  ])("%s has an alpha channel, and no ground: each corner is clear", (path, px) => {
    const png = readPng(path);
    expect(png.colourType, `${path} is RGBA`).toBe(6);
    for (const [x, y] of corners(px)) expect(png.at(x!, y!)[3], `${path} at (${x}, ${y})`).toBe(0);
  });

  it.each([
    ["public/favicon-32.png", 32],
    ["public/favicon-64.png", 64],
  ])("%s keeps the circle in the pin, opaque cream", (path, px) => {
    const scale = px / TAB_CUT.size;
    const x = Math.floor((CIRCLE.x - TAB_CUT.left) * scale);
    const y = Math.floor((CIRCLE.y - TAB_CUT.top) * scale);
    const pixel = readPng(path).at(x, y);
    expect(pixel[3], `${path} at (${x}, ${y})`).toBe(255);
    expect(distance(pixel, cream()), `${path} at (${x}, ${y}) is cream: ${pixel.join(", ")}`).toBeLessThan(12);
  });
});

describe("the logo with its ground cleared", () => {
  it("is the logo's size, RGBA, clear at each corner", () => {
    const png = readPng(CLEAR_LOGO);
    expect({ width: png.width, height: png.height, colourType: png.colourType }).toEqual({ width: 1024, height: 1024, colourType: 6 });
    for (const [x, y] of corners(1024)) expect(png.at(x!, y!)[3], `(${x}, ${y})`).toBe(0);
  });

  it("keeps the circle in the pin, opaque cream: no path from the edge reaches it", () => {
    expect(readPng(CLEAR_LOGO).at(CIRCLE.x, CIRCLE.y)).toEqual(cream());
  });

  it("leaves no cream round what it clears: each pixel beside a clear one is the outline's ink", () => {
    const png = readPng(CLEAR_LOGO);
    const ground = cream();
    const halo: string[] = [];
    for (let y = 1; y < png.height - 1; y++) {
      for (let x = 1; x < png.width - 1; x++) {
        const pixel = png.at(x, y);
        if (pixel[3] === 0) continue;
        const besideClear = [png.at(x - 1, y), png.at(x + 1, y), png.at(x, y - 1), png.at(x, y + 1)].some(([, , , a]) => a === 0);
        if (besideClear && distance(pixel, ground) < 100) halo.push(`(${x}, ${y}): ${pixel.join(", ")}`);
      }
    }
    expect(halo.slice(0, 10), `${halo.length} pixels`).toEqual([]);
  });
});

describe("the icons that keep the logo's ground", () => {
  it("the logo itself is RGB, with no alpha channel", () => {
    expect(readPng(LOGO).colourType).toBe(2);
  });

  // A phone's home screen draws a clear pixel black, and the badge is drawn on any page: each keeps the cream.
  it.each([
    ["public/apple-touch-icon.png", 180],
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
    ["src/assets/house/house-64.png", 64],
    ["src/assets/house/house-96.png", 96],
  ])("%s is opaque, cream at each corner", (path, px) => {
    const png = readPng(path);
    for (const [x, y] of corners(px)) {
      const pixel = png.at(x!, y!);
      expect(pixel[3], `${path} at (${x}, ${y})`).toBe(255);
      expect(distance(pixel, cream()), `${path} at (${x}, ${y}): ${pixel.join(", ")}`).toBeLessThan(12);
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
