// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import type { RelayReader } from "../src/nostr/events";
import { PLACE_KIND } from "../src/places/place";
import { fetchSharedPlaces, SHARE_FLOOR } from "../src/share/fetchPlaces";
import { writeSharedPages } from "../src/share/run";
import { createMemoryReader } from "./support/memoryReader";

// The places the pages a shared link opens are made from: the curator's list as the hub sends it,
// each signature checked, the newest version at each address, and at least the floor of them, or
// nothing at all. The places are signed here with a key made for the test, which stands in for the
// house's.

// nostr-tools' own check of a signature, remembered for each event it was given, whole (all seven of
// its fields): checking the list's 5,000 takes seconds, so they are checked once for the file, not
// once a test. An event changed in any way is another event, and is checked afresh.
vi.mock("nostr-tools/pure", async (importOriginal) => {
  const real = await importOriginal<typeof import("nostr-tools/pure")>();
  const results = new Map<string, boolean>();
  return {
    ...real,
    verifyEvent(event: NostrEvent) {
      const { id, pubkey, created_at, kind, tags, content, sig } = event;
      const whole = JSON.stringify([id, pubkey, created_at, kind, tags, content, sig]);
      let valid = results.get(whole);
      if (valid === undefined) {
        valid = real.verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
        results.set(whole, valid);
      }
      return valid;
    },
  };
});

/** One second of the list's import: the importer signs a whole run at one time. */
const BASE = 1_791_242_721;

const house = generateSecretKey();
const stranger = generateSecretKey();

/** As the hub sends it: a plain copy, with nothing nostr-tools kept on the object it signed. */
const asSent = (event: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(event)) as NostrEvent;

const dOf = (event: { tags: string[][] }) => event.tags.find((tag) => tag[0] === "d")?.[1];

/** A cafe of the list near Funchal, at `d`, named `name`, signed with `secret` at `created_at`. */
function signedPlace(d: string, name: string, { secret = house, created_at = BASE, i = 0 } = {}): NostrEvent {
  const tags = [
    ["d", d],
    ["z", config.headerCoordinate],
    ["name", name],
    ["category", "cafe"],
    ["country", "PT"],
    ["lat", String(32.6507 + (i % 100) / 10_000)],
    ["lon", String(-16.9084 + Math.floor(i / 100) / 10_000)],
    ["g", "etgcxpyg8"],
  ];
  return finalizeEvent({ kind: PLACE_KIND, created_at, tags, content: "" }, secret) as NostrEvent;
}

/** The list: `SHARE_FLOOR` places of the curator's, each its own, signed once for every test. */
let list: NostrEvent[] = [];
const before = { houseHex: config.houseHex };

beforeAll(() => {
  config.houseHex = getPublicKey(house);
  list = Array.from({ length: SHARE_FLOOR }, (_, i) => signedPlace(`share-${i}`, `Place ${i}`, { i }));
}, 120_000);

afterAll(() => {
  config.houseHex = before.houseHex;
});

/** A reader that sends whatever is asked of whoever signed it: a hub that does not hold to the request's `authors`. */
function carelessReader(events: NostrEvent[]): RelayReader {
  const inner = createMemoryReader(events);
  return { req: ({ authors: _authors, ...filter }, signal) => inner.req(filter, signal) };
}

const never = () => new AbortController().signal;

describe("fetchSharedPlaces", () => {
  it("holds the pages to at least 5,000 places", () => {
    expect(SHARE_FLOOR).toBe(5_000);
  });

  it(
    "gives back every place of a list of 5,000 as the hub sends it, each signature checked, asked as the app asks",
    async () => {
      const reader = createMemoryReader(list.map(asSent));
      const places = await fetchSharedPlaces(reader, never());

      expect(places).toHaveLength(5_000);
      expect(new Set(places.map((place) => place.d))).toEqual(new Set(list.map(dOf)));
      expect(places.every((place) => place.pubkey === config.houseHex)).toBe(true);
      expect(reader.requests).toEqual([
        { kinds: [PLACE_KIND], authors: [config.houseHex], "#z": [config.headerCoordinate], limit: 10_000 },
      ]);
    },
    120_000,
  );

  it("throws for a list of 4,999: fewer than the floor, so part of the list is missing", async () => {
    await expect(fetchSharedPlaces(createMemoryReader(list.slice(1)), never())).rejects.toThrow(/4999 places.*5000/);
  });

  describe("a place that is not the curator's, or not as the curator signed it", () => {
    const foreign = () => asSent(signedPlace("foreign", "Foreign Cafe", { secret: stranger }));
    const tampered = () => ({ ...asSent(signedPlace("tampered", "Tampered Cafe")), content: "changed after it was signed" });

    it("is left out: a place signed by another key under the list's header, and one changed after it was signed", async () => {
      const places = await fetchSharedPlaces(carelessReader([...list, foreign(), tampered()]), never());

      expect(places).toHaveLength(5_000);
      const ds = new Set(places.map((place) => place.d));
      expect(ds.has("foreign")).toBe(false);
      expect(ds.has("tampered")).toBe(false);
      expect(places.every((place) => place.pubkey === config.houseHex)).toBe(true);
    });

    it("counts for nothing: 4,999 of the curator's with those two are fewer than the floor", async () => {
      const reader = carelessReader([...list.slice(1), foreign(), tampered()]);
      await expect(fetchSharedPlaces(reader, never())).rejects.toThrow(/4999 places/);
    });

    it("takes no older version in the place of a newer one that fails its check, as the app takes none", async () => {
      const forgedNewer = { ...asSent(signedPlace("share-0", "Place 0, renamed", { created_at: BASE + 1 })), content: "changed" };
      const extra = signedPlace("extra", "Extra Cafe");
      const places = await fetchSharedPlaces(createMemoryReader([...list, extra, forgedNewer]), never());

      expect(places).toHaveLength(5_000);
      expect(places.some((place) => place.d === "share-0")).toBe(false);
    });
  });

  it("keeps the newer of two versions of one place", async () => {
    const newer = signedPlace("share-7", "Place 7, renamed", { created_at: BASE + 60 });
    const places = await fetchSharedPlaces(createMemoryReader([newer, ...list]), never());

    expect(places).toHaveLength(5_000);
    expect(places.filter((place) => place.d === "share-7").map((place) => place.name)).toEqual(["Place 7, renamed"]);
  });

  describe("a hub that sends part of the list", () => {
    it("throws when it fails in the middle of its answer, and gives back nothing", async () => {
      const partial: RelayReader = {
        async *req() {
          yield* list.slice(0, 3_000);
          throw new Error("The connection was lost");
        },
      };
      await expect(fetchSharedPlaces(partial, never())).rejects.toThrow("The connection was lost");
    });

    it("throws when it sends a full page and then fails on the next", async () => {
      const filters: unknown[] = [];
      // 10,000 events, each place twice: a full page, which is followed by the next.
      const firstPageThenFail: RelayReader = {
        async *req(filter) {
          filters.push(filter);
          if (filters.length > 1) throw new Error("The hub stopped answering");
          yield* [...list, ...list];
        },
      };
      await expect(fetchSharedPlaces(firstPageThenFail, never())).rejects.toThrow("The hub stopped answering");
      expect(filters).toHaveLength(2);
    });

    it("throws when its pages get no further back, as the list may hold more than came", async () => {
      // A full page every time, of the same places: the paging cannot get past them.
      const stuck: RelayReader = {
        async *req() {
          yield* [...list, ...list];
        },
      };
      await expect(fetchSharedPlaces(stuck, never())).rejects.toThrow(/did not come to its end/);
    });

    it("throws when it sends a short answer: the floor stops it", async () => {
      await expect(fetchSharedPlaces(createMemoryReader(list.slice(0, 3_000)), never())).rejects.toThrow(/3000 places/);
    });
  });

  it("throws when the hub does not answer", async () => {
    const reader = createMemoryReader(list, { failWith: new Error("No answer from the hub") });
    await expect(fetchSharedPlaces(reader, never())).rejects.toThrow("No answer from the hub");
  });

  it("throws with the signal's reason when it aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(fetchSharedPlaces(createMemoryReader(list), controller.signal)).rejects.toThrow("Stopped");
  });
});

/** A built page, as `npm run build` writes it, cut down to what the writer reads: a title and the end of a head. */
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Regulars</title>
    <meta name="description" content="Places to eat and drink, rated by people you'd actually ask." />
    <script type="module" crossorigin src="/assets/index-Bs5sUFrr.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

/** Every file under `dir`, relative to it, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe("writeSharedPages", () => {
  const folders: string[] = [];

  /** A folder of its own for the test, holding the built site's index.html unless `built` is false. */
  async function siteFolder({ built = true } = {}): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "regulars-share-"));
    folders.push(folder);
    if (built) await writeFile(join(folder, "index.html"), INDEX_HTML);
    return folder;
  }

  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  });

  it("writes each page at its file, with the sitemap and robots.txt, and leaves index.html as it was", async () => {
    const folder = await siteFolder();
    const twins = [1, 2].map((i) => signedPlace(`twin-${i}`, "A Confeitaria Coffee & Bakery", { i }));
    const written = await writeSharedPages(folder, createMemoryReader([...list, ...twins]), never());

    expect(written).toEqual({ places: 5_002, placePages: 5_002, chainPages: 1, fixedPages: 8 });
    const files = await filesUnder(folder);
    expect(files).toHaveLength(1 + 5_002 + 1 + 8 + 2);
    expect(files).toContain("trending.html");
    expect(files).toContain("place/share-0.html");
    expect(files).toContain("place/twin-1.html");
    expect(files).toContain("chain/PT:a confeitaria coffee & bakery.html");
    expect(files).toContain("sitemap.xml");
    expect(files).toContain("robots.txt");
    expect(await readFile(join(folder, "index.html"), "utf8")).toBe(INDEX_HTML);

    const page = await readFile(join(folder, "place/share-0.html"), "utf8");
    expect(page).toContain("<title>Place 0 · Regulars</title>");
    expect(page).toContain('<link rel="canonical" href="https://askregulars.world/place/share-0" />');

    const sitemap = await readFile(join(folder, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://askregulars.world/chain/PT:a%20confeitaria%20coffee%20%26%20bakery</loc>");
    expect(sitemap.match(/<loc>/g)).toHaveLength(1 + 5_002 + 1 + 8);
    expect(await readFile(join(folder, "robots.txt"), "utf8")).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://askregulars.world/sitemap.xml\n",
    );
  });

  it("writes nothing when the list cannot be had", async () => {
    const folder = await siteFolder();
    await expect(writeSharedPages(folder, createMemoryReader(list.slice(0, 10)), never())).rejects.toThrow(/10 places/);
    const failing = createMemoryReader(list, { failWith: new Error("No answer from the hub") });
    await expect(writeSharedPages(folder, failing, never())).rejects.toThrow("No answer from the hub");

    expect(await filesUnder(folder)).toEqual(["index.html"]);
  });

  it("asks the hub nothing and writes nothing when the folder holds no built page", async () => {
    const folder = await siteFolder({ built: false });
    const reader = createMemoryReader(list);
    await expect(writeSharedPages(folder, reader, never())).rejects.toThrow(/index\.html/);

    expect(reader.requests).toEqual([]);
    expect(await filesUnder(folder)).toEqual([]);
  });
});
