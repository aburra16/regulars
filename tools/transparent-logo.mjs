/*
 * Clears the cream ground from the house's logo, for the tab icon: a browser draws the tab icon on its own
 * tab bar, light or dark, so a square of cream round the pin shows as a box. tools/house-icons.sh runs it.
 *
 *   node tools/transparent-logo.mjs <logo.png> <out.png>
 *     Reads an 8-bit RGB PNG and writes it as RGBA, with the ground clear. The ground is every pixel near
 *     the cream that a path of such pixels joins to the picture's edge, so the cream circle inside the pin,
 *     which the pin's outline closes off, stays. The pixels where the ground meets the outline are part
 *     cream, part ink: each is un-mixed from the cream, so it keeps the ink and only its share of it as alpha.
 *
 *   node tools/transparent-logo.mjs --preview <dir> <icon.png>...
 *     Draws the icons side by side, each 4 times its size with no smoothing, on white and on the dark
 *     theme's ground, into <dir>/preview-light.png and <dir>/preview-dark.png: to look at before committing.
 *
 * Node only, no packages: the PNGs are read and written with zlib (PNG spec: https://www.w3.org/TR/png-3/).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour types this reads, by the channels each has: RGB, and RGB with alpha. */
const CHANNELS = { 2: 3, 6: 4 };

/** A pixel this close to the cream, in RGB, is ground if the ground reaches it. */
const GROUND_TOLERANCE = 48;

/** How far in from the ground to look for the edge's part-cream pixels: the logo's edges are 1 to 2 px. */
const EDGE_DEPTH = 3;

/** The theme grounds the preview draws the icons on: white, and the dark theme's (index.html's theme colours). */
const PREVIEW_GROUNDS = { light: [0xff, 0xff, 0xff], dark: [0x10, 0x16, 0x1f] };
const PREVIEW_SCALE = 4;
const PREVIEW_GAP = 16;

/**
 * Reads a PNG: 8-bit RGB or RGBA, not interlaced. Returns its pixels as RGBA, 4 bytes each, a line at a time.
 * Throws on any other kind of PNG, since this has no need to read one.
 */
function decodePng(bytes, name = "PNG") {
  if (!SIGNATURE.equals(bytes.subarray(0, 8))) throw new Error(`${name} is not a PNG`);
  let header;
  const idat = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error(`${name} has no IHDR chunk`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [bitDepth, colourType, compression, filterMethod, interlace] = header.subarray(8, 13);
  const channels = CHANNELS[colourType];
  if (bitDepth !== 8 || !channels || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(
      `${name}: this reads 8-bit RGB or RGBA PNGs, not interlaced; it is ${bitDepth}-bit, colour type ${colourType}, interlace ${interlace}`,
    );
  }

  const stride = width * channels;
  const lines = inflateSync(Buffer.concat(idat));
  if (lines.length !== height * (stride + 1)) throw new Error(`${name}: its image data is ${lines.length} bytes, not ${height * (stride + 1)}`);
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = lines[y * (stride + 1)];
    const line = lines.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? raw[row + i - channels] : 0;
      const up = y > 0 ? raw[row - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? raw[row - stride + i - channels] : 0;
      let predictor;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = left; break;
        case 2: predictor = up; break;
        case 3: predictor = (left + up) >> 1; break;
        case 4: predictor = paeth(left, up, upLeft); break;
        default: throw new Error(`${name}: line ${y} has filter type ${filter}, which PNG does not have`);
      }
      raw[row + i] = (line[i] + predictor) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = raw[p * channels];
    rgba[p * 4 + 1] = raw[p * channels + 1];
    rgba[p * 4 + 2] = raw[p * channels + 2];
    rgba[p * 4 + 3] = channels === 4 ? raw[p * channels + 3] : 255;
  }
  return { width, height, hasAlpha: channels === 4, rgba };
}

/** The Paeth predictor (PNG spec, 9.4): of left, up and up-left, the one nearest left + up - up-left. */
function paeth(left, up, upLeft) {
  const guess = left + up - upLeft;
  const toLeft = Math.abs(guess - left);
  const toUp = Math.abs(guess - up);
  const toUpLeft = Math.abs(guess - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Writes 8-bit RGBA pixels as a PNG, colour type 6, each line unfiltered. */
function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const lines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) lines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(lines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** The colour most pixels of a list have, as [r, g, b]. */
function commonest(rgba, pixels) {
  const counts = new Map();
  for (const p of pixels) {
    const key = (rgba[p * 4] << 16) | (rgba[p * 4 + 1] << 8) | rgba[p * 4 + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return [key >> 16, (key >> 8) & 0xff, key & 0xff];
}

const distance = (rgba, p, [r, g, b]) => Math.hypot(rgba[p * 4] - r, rgba[p * 4 + 1] - g, rgba[p * 4 + 2] - b);

/** The pixels beside a pixel: up, down, left, right and the diagonals, within the picture. */
function neighbours(p, width, height) {
  const x = p % width;
  const y = (p - x) / width;
  const around = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) around.push(p + dy * width + dx);
    }
  }
  return around;
}

/**
 * Clears an image's ground: the cream that reaches its edge. Returns new RGBA pixels and the two colours
 * it found, the cream and the outline's ink.
 */
function clearGround({ width, height, rgba }) {
  const count = width * height;
  const edge = [];
  for (let x = 0; x < width; x++) edge.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) edge.push(y * width, y * width + width - 1);

  // The cream: the colour most of the edge is. The ground is the cream the edge reaches, through pixels near it.
  const cream = commonest(rgba, edge);
  const ground = new Uint8Array(count);
  const queue = edge.filter((p) => distance(rgba, p, cream) <= GROUND_TOLERANCE);
  for (const p of queue) ground[p] = 1;
  for (let i = 0; i < queue.length; i++) {
    for (const q of neighbours(queue[i], width, height)) {
      if (!ground[q] && distance(rgba, q, cream) <= GROUND_TOLERANCE) {
        ground[q] = 1;
        queue.push(q);
      }
    }
  }
  if (queue.length === count) throw new Error("the whole picture is ground: there is nothing to keep");

  // The pixels where the ground meets the picture, in rings: the first beside the ground, the next beside
  // that, and so on. The ink is the colour of the deepest ring, past the edge's mixed pixels.
  const rings = [];
  const seen = Uint8Array.from(ground);
  let ring = queue;
  for (let depth = 0; depth <= EDGE_DEPTH; depth++) {
    const next = [];
    for (const p of ring) {
      for (const q of neighbours(p, width, height)) {
        if (!seen[q]) {
          seen[q] = 1;
          next.push(q);
        }
      }
    }
    rings.push(next);
    ring = next;
  }
  const ink = commonest(rgba, rings.at(-1));

  // Each pixel of the ground and of the rings is cream and ink mixed: cream + share × (ink - cream). Its
  // share of ink is its alpha, and un-mixed, its colour is what it would be with no cream under it.
  const out = Uint8Array.from(rgba);
  const along = ink.map((c, i) => c - cream[i]);
  const length2 = along.reduce((sum, c) => sum + c * c, 0);
  if (length2 < GROUND_TOLERANCE ** 2) throw new Error(`the outline's ink, ${ink}, is too near the cream, ${cream}, to tell apart`);
  const unmix = (p) => {
    const offset = [0, 1, 2].map((i) => rgba[p * 4 + i] - cream[i]);
    const share = Math.min(1, Math.max(0, offset.reduce((sum, c, i) => sum + c * along[i], 0) / length2));
    const alpha = Math.round(share * 255);
    for (let i = 0; i < 3; i++) {
      // A clear pixel keeps the ink, so nothing that smooths the image can bring the cream back in.
      out[p * 4 + i] = alpha === 0 ? ink[i] : Math.min(255, Math.max(0, Math.round(cream[i] + offset[i] / share)));
    }
    out[p * 4 + 3] = alpha;
    return alpha;
  };
  for (const p of queue) unmix(p);
  // A ring's pixel is only part of the edge if the ground, or a part-cream pixel, is beside it: deeper in,
  // the picture keeps its own colours, cream ones too.
  const edgy = Uint8Array.from(ground);
  for (const ringPixels of rings.slice(0, EDGE_DEPTH)) {
    for (const p of ringPixels) {
      if (!neighbours(p, width, height).some((q) => edgy[q])) continue;
      if (unmix(p) < 255) edgy[p] = 1;
    }
  }
  return { width, height, rgba: out, cream, ink };
}

/** The icons side by side, each scaled up with no smoothing, on a ground of one colour. */
function preview(icons, ground) {
  const width = icons.reduce((sum, icon) => sum + icon.width * PREVIEW_SCALE + PREVIEW_GAP, PREVIEW_GAP);
  const height = Math.max(...icons.map((icon) => icon.height * PREVIEW_SCALE)) + 2 * PREVIEW_GAP;
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) rgba.set([...ground, 255], p * 4);
  let left = PREVIEW_GAP;
  for (const icon of icons) {
    for (let y = 0; y < icon.height * PREVIEW_SCALE; y++) {
      for (let x = 0; x < icon.width * PREVIEW_SCALE; x++) {
        const from = (Math.floor(y / PREVIEW_SCALE) * icon.width + Math.floor(x / PREVIEW_SCALE)) * 4;
        const to = ((PREVIEW_GAP + y) * width + left + x) * 4;
        const alpha = icon.rgba[from + 3] / 255;
        for (let i = 0; i < 3; i++) rgba[to + i] = Math.round(icon.rgba[from + i] * alpha + ground[i] * (1 - alpha));
      }
    }
    left += icon.width * PREVIEW_SCALE + PREVIEW_GAP;
  }
  return { width, height, rgba };
}

function main(args) {
  if (args[0] === "--preview" && args.length >= 3) {
    const [, dir, ...paths] = args;
    const icons = paths.map((path) => decodePng(readFileSync(path), path));
    mkdirSync(dir, { recursive: true });
    for (const [name, ground] of Object.entries(PREVIEW_GROUNDS)) {
      writeFileSync(join(dir, `preview-${name}.png`), encodePng(preview(icons, ground)));
    }
    return;
  }
  if (args.length === 2 && !args[0].startsWith("-")) {
    const [from, to] = args;
    const logo = decodePng(readFileSync(from), from);
    if (logo.hasAlpha) throw new Error(`${from} has an alpha channel already: this clears the ground of an opaque logo`);
    const { cream, ink, ...clear } = clearGround(logo);
    writeFileSync(to, encodePng(clear));
    const hex = (colour) => `#${colour.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    console.log(`${to}: cleared the ${hex(cream)} ground, un-mixing its edge from the ${hex(ink)} outline`);
    return;
  }
  console.error("usage: node tools/transparent-logo.mjs <logo.png> <out.png>\n       node tools/transparent-logo.mjs --preview <dir> <icon.png>...");
  process.exitCode = 2;
}

main(process.argv.slice(2));
