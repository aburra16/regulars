/*
 * The pages a shared link opens, made ahead of time: one for each place and each chain on the list,
 * and one for each of the app's fixed pages, at the address the app's own links use. Each is the
 * built index.html with its own title and the tags a link's preview is read from (./head.ts), so a
 * link pasted where no app runs (a chat, a feed, a search engine) shows the place, and the address
 * answers with a page of its own. In the browser, the page is the app, as at any other address.
 *
 * Each page's file is named as a host looks it up. A host decodes the request's path once before it
 * looks for a file (GitHub Pages and nginx read `/place/caf%C3%A9` as `place/café`), so the file is
 * named by the address decoded, while the page's links, its canonical address and the sitemap keep
 * the address as the app's links write it. And each is `<address>.html`, not a folder's index.html:
 * GitHub Pages answers `/place/x` from `place/x.html` with the page itself, where a folder would
 * answer with a redirect to `/place/x/`, which the app's routes do not expect. A host that does not
 * look for `<path>.html` by itself has to be told to: nginx's `try_files $uri $uri.html …`.
 *
 * The writer makes the pages and gives them back; it writes no file and reads nothing but what it is
 * given. A preview says no rating: a place's rating depends on whose view it is, and changes between
 * one making of the pages and the next.
 */
import { WHY_PATH } from "../circle/paths.ts";
import { copy } from "../copy/en.ts";
import { countryName } from "../places/countries.ts";
import { type Chain, chainSlug, type City, cityLabeller, type Indexes } from "../places/indexes.ts";
import { kindOf, placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { placePath } from "../review/paths.ts";
import { isHttpsUrl } from "../reviews/review.ts";
import { escapeMarkup, type HeadFields, withHead } from "./head.ts";

/** A page of the site, made ahead. */
export interface SharePage {
  /**
   * Where its file goes, relative to the built site's folder: its address as a host decodes it, and
   * `.html`. `place/café 1%.html` for `/place/caf%C3%A9%201%25`; `trending.html` for `/trending`.
   */
  path: string;
  /** Its full address, as the app's own links write it: `https://askregulars.world/place/caf%C3%A9%201%25`. */
  url: string;
  html: string;
}

/** What the pages are made from. */
export interface ShareInput {
  /** The built site's index.html. */
  indexHtml: string;
  /** The places of the list, as the app reads them. */
  places: readonly Place[];
  /** `buildIndexes` of `places`, with the towns the app puts them in. */
  indexes: Indexes;
  /** Where the site is: `https://askregulars.world`. */
  origin: string;
}

/** What each page's file name ends with, after its address. */
const PAGE_SUFFIX = ".html";

/** The sitemap's file, at the root of the site; robots.txt names it. */
export const SITEMAP_FILE = "sitemap.xml";

/** The picture of a preview that has none of its own: the Regulars card, at the root of the site. */
const CARD_PATH = "/og-card.png";

/**
 * The app's pages that are the same for everyone, at their addresses in src/routes.tsx, each with
 * the title it gives itself. Not a reviewer's page (anyone can have one, so they cannot be made
 * ahead), a review form, Filters, nor Recent, which sends its visitor on to Trending.
 */
const FIXED_PAGES: readonly { path: string; title: string }[] = [
  { path: "/trending", title: copy.titles.recent },
  { path: "/about", title: copy.titles.about },
  { path: WHY_PATH, title: copy.titles.why },
  { path: "/map", title: copy.titles.map },
  { path: "/search", title: copy.titles.search },
  { path: "/you", title: copy.titles.you },
  { path: "/saved", title: copy.titles.saved },
  { path: "/signin", title: copy.titles.signin },
];

/** The longest a file's name may be, in bytes: 255, on the file systems the site is built on. */
const FILE_NAME_MAX_BYTES = 255;

/** What no file's name may hold: a separator of paths, or a control character. */
const UNSAFE_CHARACTER = /[/\\\u0000-\u001f\u007f-\u009f]/;

const utf8 = new TextEncoder();

/**
 * Whether `name`, the last part of a page's address as a host decodes it, can name the page's file:
 * it holds no separator of paths and no control character, it is neither empty nor `.` or `..`, it
 * does not end in `.html` in any case (a host answers `/place/x.html` with the file `place/x.html`,
 * the page of the place whose `d` is `x`), and the file's name (`name` and `.html`) is at most
 * `FILE_NAME_MAX_BYTES` in UTF-8. A run of dots inside a name is safe.
 */
function isSafeName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !UNSAFE_CHARACTER.test(name) &&
    !name.toLowerCase().endsWith(PAGE_SUFFIX) &&
    utf8.encode(`${name}${PAGE_SUFFIX}`).length <= FILE_NAME_MAX_BYTES
  );
}

/**
 * The file a host that decodes the request's path once looks up for `address` (`/place/caf%C3%A9`
 * is `place/café.html`); undefined when the decoded name cannot be a file's (`isSafeName`).
 */
function fileOf(address: string): string | undefined {
  const slash = address.lastIndexOf("/");
  const name = decodeURIComponent(address.slice(slash + 1));
  return isSafeName(name) ? `${address.slice(1, slash + 1)}${name}${PAGE_SUFFIX}` : undefined;
}

/**
 * The address `write` makes, or undefined when a name in it cannot be written in one: a lone
 * surrogate, on which `encodeURIComponent` throws. That one page is not made; the others are.
 */
function addressOf(write: () => string): string | undefined {
  try {
    return write();
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

/** The site's own origin, from `origin` however it is written: `https://askregulars.world`. Throws for what is not an address. */
const siteOrigin = (origin: string) => new URL(origin).origin;

/** `cityLabeller` for each list of towns, made once for it: a labeller reads the whole list. */
const labellers = new WeakMap<readonly City[], (city: City) => string>();

/**
 * What a place's description calls its town, as the app labels it (`cityLabeller`): "Funchal", or,
 * where two towns share a name, "Lexington, KY". Where the label tells two towns apart by their
 * country alone, the town's name, since the country is named after it.
 */
function townLabel(town: City, indexes: Indexes): string {
  let label = labellers.get(indexes.cities);
  if (label === undefined) {
    label = cityLabeller(indexes.cities);
    labellers.set(indexes.cities, label);
  }
  return town.region === undefined ? town.name : label(town);
}

/** What `placeKindLabel` puts between a kind and a cuisine it writes after it: "Fast food · Burger". */
const KIND_AND_CUISINE = " · ";

/**
 * What a place is, as the app's lists word it (`placeKindLabel`: "Coffee shop", "Mexican
 * restaurant") when that is one phrase; for a kind the app writes its cuisine after, with a dot
 * ("Food court · Sushi"), which "in Funchal" cannot follow, the kind alone (`kindOf`: "Food court").
 */
function kindWords(place: Place): string {
  const label = placeKindLabel(place.category, place.cuisine);
  return label.includes(KIND_AND_CUISINE) ? kindOf(place.category).label : label;
}

/**
 * What a link to a place says of it: what it is (`kindWords`); where it is, by its town
 * (`Indexes.townOf`) and the town's country, or for a place in no town its region and its own
 * country; how it takes Bitcoin, when it does; and the line every place's ends with: "Coffee shop in
 * Funchal, Portugal. Takes Bitcoin over Lightning. Rated by people you'd actually ask." What is not
 * known is left out. No rating.
 */
export function placeDescription(place: Place, indexes: Indexes): string {
  const town = indexes.townOf(place);
  const where = town === undefined ? place.region?.trim() : townLabel(town, indexes);
  const country = countryName(town?.country || (place.country ?? ""));
  const known = [where, country].filter((part): part is string => part !== undefined && part !== "");
  const bitcoin = place.acceptsBitcoin === undefined ? undefined : copy.share.bitcoin[place.acceptsBitcoin];
  return [copy.share.place(kindWords(place), ...known), bitcoin, copy.share.rated].filter((sentence) => sentence !== undefined).join(" ");
}

/** What a link to a chain says of it: "4 locations in Portugal. Rated by people you'd actually ask." No rating. */
export function chainDescription(chain: Chain): string {
  return `${copy.share.chain(chain.places.length, countryName(chain.country))} ${copy.share.rated}`;
}

/**
 * The page of each of the app's fixed pages, every place of the list and every chain the app has
 * (`Indexes.chains`), at the app's own address for it (`placePath`, `/chain/` and `chainSlug`), each
 * the built page with its own title, description, picture and address (`withHead`), in the file a
 * host looks up for that address (`fileOf`). None is made for a place whose `d`, or a chain whose
 * name, cannot be written in an address or name a file, nor for a second place of one `d`: the app
 * opens the first. Throws as `withHead` does, for a page with no title or no end of its head.
 */
export function sharePages({ indexHtml, places, indexes, origin }: ShareInput): SharePage[] {
  const base = siteOrigin(origin);
  const card = `${base}${CARD_PATH}`;
  const pages: SharePage[] = [];
  const add = (address: string | undefined, fields: () => Omit<HeadFields, "url">) => {
    const path = address === undefined ? undefined : fileOf(address);
    if (path === undefined) return;
    const url = `${base}${address}`;
    pages.push({ path, url, html: withHead(indexHtml, { ...fields(), url }) });
  };

  for (const { path, title } of FIXED_PAGES) add(path, () => ({ title, description: copy.meta.description, image: card }));
  for (const place of places) {
    if (indexes.byD.get(place.d) !== place) continue;
    add(addressOf(() => placePath(place.d)), () => ({
      title: copy.titles.place(place.name),
      description: placeDescription(place, indexes),
      image: place.image !== undefined && isHttpsUrl(place.image) ? place.image : card,
    }));
  }
  for (const chain of indexes.chains.values()) {
    add(addressOf(() => `/chain/${chainSlug(chain)}`), () => ({
      title: copy.titles.chain(chain.name),
      description: chainDescription(chain),
      image: card,
    }));
  }
  return pages;
}

/** The sitemap of the site (sitemaps.org's): the home page and the address of each of `pages`, once each. */
export function sitemap(pages: readonly SharePage[], origin: string): string {
  const addresses = new Set([`${siteOrigin(origin)}/`, ...pages.map((page) => page.url)]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...[...addresses].map((address) => `  <url><loc>${escapeMarkup(address)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

/** The site's robots.txt: every page may be read, and the sitemap is at the root. */
export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${siteOrigin(origin)}/${SITEMAP_FILE}\n`;
}
