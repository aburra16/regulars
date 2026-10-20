import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { config } from "../config.ts";
import type { RelayReader } from "../nostr/events.ts";
import { buildIndexes } from "../places/indexes.ts";
import { relayReader } from "../places/relayReader.ts";
import { loadTowns } from "../places/towns.ts";
import { fetchSharedPlaces } from "./fetchPlaces.ts";
import { robotsTxt, SITEMAP_FILE, sharePages, sitemap } from "./pages.ts";

/*
 * The step of the website's deploy that writes the pages a shared link opens into the built site
 * (`npm run share-pages`, tools/share-pages.ts, which loads this module through Vite so that it runs
 * as the app's own code does). It runs after `npm run build`, never as part of it: the Android
 * release and the nSite are published from the build alone. Nothing in the app imports it.
 */

/** The site's own address, which every page's links and the sitemap name. */
const ORIGIN = `https://${config.domain}`;

/** The built site's page, which every page is a copy of. */
const INDEX_FILE = "index.html";

/** The robots.txt of the site, at its root. */
const ROBOTS_FILE = "robots.txt";

/** What a run of the step wrote: how many places the hub's list held, and how many pages of each it wrote. */
export interface SharedPagesWritten {
  places: number;
  placePages: number;
  chainPages: number;
  fixedPages: number;
}

/**
 * Writes the pages a shared link opens into `dist`, the built site's folder: a page for each place
 * of the list (`fetchSharedPlaces`, read from `reader`), each chain the app has of them (with the
 * app's towns, as the app builds its indexes) and each fixed page, each at its file (./pages.ts),
 * with `sitemap.xml` and `robots.txt`. Every page is made before any file is written: a run with
 * no built page in `dist`, no list (`fetchSharedPlaces`) or no towns writes none, and throws. A file
 * that cannot be written throws too, and the deploy stops.
 */
export async function writeSharedPages(dist: string, reader: RelayReader, signal: AbortSignal): Promise<SharedPagesWritten> {
  const indexHtml = await readFile(join(dist, INDEX_FILE), "utf8");
  const places = await fetchSharedPlaces(reader, signal);
  const towns = await loadTowns();
  if (towns === null) throw new Error("The towns of src/data/towns.json did not load.");
  const pages = sharePages({ indexHtml, places, indexes: buildIndexes(places, towns), origin: ORIGIN });

  const files = new Map<string, string>(pages.map((page) => [page.path, page.html]));
  files.set(SITEMAP_FILE, sitemap(pages, ORIGIN));
  files.set(ROBOTS_FILE, robotsTxt(ORIGIN));
  const root = resolve(dist);
  const folders = new Set<string>();
  for (const [path, text] of files) {
    const file = resolve(root, path);
    // The writer makes no such path (it refuses a name with a separator, `.` or `..`): the floor under that.
    if (!file.startsWith(`${root}${sep}`)) throw new Error(`The page ${path} would fall outside ${dist}.`);
    const folder = dirname(file);
    if (!folders.has(folder)) await mkdir(folder, { recursive: true });
    folders.add(folder);
    await writeFile(file, text);
  }

  const counted = (prefix: string) => pages.filter((page) => page.path.startsWith(prefix)).length;
  const placePages = counted("place/");
  const chainPages = counted("chain/");
  return { places: places.length, placePages, chainPages, fixedPages: pages.length - placePages - chainPages };
}

/**
 * The step as the deploy runs it: the pages of the hub's list, read through the app's reader of the
 * places relay (`config.placesRelay`, src/places/relayReader.ts), whose limits end a request the hub
 * does not answer, written into `dist`. Gives back the one line it prints.
 */
export async function shareStep(dist: string): Promise<string> {
  const written = await writeSharedPages(dist, relayReader, new AbortController().signal);
  return (
    `${written.places} places from ${config.placesRelay}: wrote ${written.placePages} place pages, ` +
    `${written.chainPages} chain pages and ${written.fixedPages} fixed pages into ${dist}, with ${SITEMAP_FILE} and ${ROBOTS_FILE}.`
  );
}
