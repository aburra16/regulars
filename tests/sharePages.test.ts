import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { buildIndexes, type Chain, chainSlug } from "../src/places/indexes";
import { PLACE_KIND, type Place } from "../src/places/place";
import { placePath } from "../src/review/paths";
import { routes } from "../src/routes";
import { withHead } from "../src/share/head";
import { chainDescription, placeDescription, robotsTxt, type SharePage, sharePages, sitemap } from "../src/share/pages";
import { townsOf } from "./support/towns";

// The pages a link to a place, a chain or a fixed page opens, made ahead from the built index.html, each
// with its own title and the tags a link's preview is read from. The fixture is the page as
// `npm run build` writes it: the character set, the policy, the title and description, the icons, the
// theme's script, and Vite's module script, preloads and stylesheet.
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'sha256-ifAiRW7iNrv6YAKrGRjafPkLua52QvQCcRukwo2j5tw='; img-src 'self' data: blob: https:; object-src 'none'; base-uri 'self'" />
    <!-- The build puts the Content Security Policy after the character set, as a meta tag, with the hash
         of the theme's script below (tools/csp.ts). A meta tag cannot set frame-ancestors: only a header could. -->
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Regulars</title>
    <meta name="description" content="Places to eat and drink, rated by people you'd actually ask." />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#10161F" media="(prefers-color-scheme: dark)" />
    <script>
      (function () {
        var theme;
        try {
          theme = localStorage.getItem("regulars.theme");
        } catch (e) {}
        var chosen = theme === "light" || theme === "dark";
        if (!chosen) theme = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", theme);
        if (chosen) {
          var metas = document.querySelectorAll('meta[name="theme-color"]');
          for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", theme === "dark" ? "#10161F" : "#FFFFFF");
        }
      })();
    </script>
    <script type="module" crossorigin src="/assets/index-Bs5sUFrr.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/utils-BKa5XZQI.js">
    <link rel="modulepreload" crossorigin href="/assets/config-C6lGUrII.js">
    <link rel="stylesheet" crossorigin href="/assets/index-1cY1R-yU.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const ORIGIN = "https://askregulars.world";
const CARD = "https://askregulars.world/og-card.png";
const RATED = "Rated by people you'd actually ask.";

/** Funchal, and the places near it that the tests put in it. */
const FUNCHAL = { lat: 32.6507, lon: -16.9084 };

/** The towns of the tests: Funchal; two Lexingtons, told apart by their state; two Valencias, in two countries. */
const towns = townsOf([
  { id: 1, name: "Funchal", country: "PT", ...FUNCHAL },
  { id: 2, name: "Lexington", country: "US", region: "KY", lat: 38.0406, lon: -84.5037 },
  { id: 3, name: "Lexington", country: "US", region: "VA", lat: 37.7840, lon: -79.4428 },
  { id: 4, name: "Valencia", country: "ES", lat: 39.4699, lon: -0.3763 },
  { id: 5, name: "Valencia", country: "VE", lat: 10.1620, lon: -68.0077 },
]);

/** A point in the Atlantic, far from every town of the tests. */
const NOWHERE = { lat: 40, lon: -40 };

let made = 0;
/** A place with only what the test names: a restaurant, in the Atlantic, in no country. */
function make(name: string, over: Partial<Place> = {}): Place {
  made += 1;
  const d = over.d ?? `osm-node-${made}`;
  return {
    address: `${PLACE_KIND}:${config.houseHex}:${d}`,
    d,
    pubkey: config.houseHex,
    name,
    category: "restaurant",
    ...NOWHERE,
    geohash: "etgcxpyg8",
    keywords: [],
    createdAt: 0,
    ...over,
  };
}

/** The pages of `places`, with the indexes the app would build of them. */
function pagesOf(places: Place[], indexHtml = INDEX_HTML): SharePage[] {
  return sharePages({ indexHtml, places, indexes: buildIndexes(places, towns), origin: ORIGIN });
}

function pageAt(pages: readonly SharePage[], path: string): SharePage {
  const page = pages.find((each) => each.path === path);
  if (page === undefined) throw new Error(`No page at ${path}; the pages are ${pages.map((each) => each.path).join(", ")}`);
  return page;
}

/** What a browser, or a link's preview, reads of a page's head. Each tag must be there exactly once. */
function headOf(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const one = (selector: string) => {
    const found = doc.head.querySelectorAll(selector);
    expect(found, selector).toHaveLength(1);
    return found[0]!;
  };
  const content = (selector: string) => one(selector).getAttribute("content");
  expect(doc.head.querySelectorAll("title")).toHaveLength(1);
  return {
    doc,
    title: doc.title,
    description: content('meta[name="description"]'),
    ogTitle: content('meta[property="og:title"]'),
    ogDescription: content('meta[property="og:description"]'),
    image: content('meta[property="og:image"]'),
    url: content('meta[property="og:url"]'),
    type: content('meta[property="og:type"]'),
    siteName: content('meta[property="og:site_name"]'),
    card: content('meta[name="twitter:card"]'),
    canonical: one('link[rel="canonical"]').getAttribute("href"),
  };
}

/** Every script element of a page, as it is written. */
const scriptsOf = (html: string) => [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)].map(([script]) => script);

describe("a place's page", () => {
  it("is at the place's own address, titled as the app titles it, with a preview of what it is, where, and how it takes Bitcoin", () => {
    const place = make("Jacafé", { d: "osm-node-4242", category: "cafe", ...FUNCHAL, country: "PT", acceptsBitcoin: "lightning" });
    const head = headOf(pageAt(pagesOf([place]), "place/osm-node-4242.html").html);

    expect(head.title).toBe("Jacafé · Regulars");
    expect(head.title).toBe(copy.titles.place("Jacafé"));
    expect(head.ogTitle).toBe(head.title);
    expect(head.description).toBe(`Cafe in Funchal, Portugal. Takes Bitcoin over Lightning. ${RATED}`);
    expect(head.ogDescription).toBe(head.description);
    expect(head.url).toBe("https://askregulars.world/place/osm-node-4242");
    expect(head.canonical).toBe(head.url);
    expect(pageAt(pagesOf([place]), "place/osm-node-4242.html").url).toBe(head.url);
    expect(head.image).toBe(CARD);
    expect(head.type).toBe("website");
    expect(head.siteName).toBe("Regulars");
    expect(head.card).toBe("summary_large_image");
  });

  it.each<[string, Partial<Place>, string]>([
    ["a town and a country, with Lightning", { ...FUNCHAL, country: "PT", acceptsBitcoin: "lightning" }, `Restaurant in Funchal, Portugal. Takes Bitcoin over Lightning. ${RATED}`],
    ["a country alone, with no Bitcoin", { country: "PT" }, `Restaurant in Portugal. ${RATED}`],
    ["the region, for a place in no town", { region: "Madeira", country: "PT" }, `Restaurant in Madeira, Portugal. ${RATED}`],
    ["a town, by its country, for a place that names none", { ...FUNCHAL }, `Restaurant in Funchal, Portugal. ${RATED}`],
    ["nothing known but the kind", {}, `Restaurant. ${RATED}`],
    ["on-chain", { country: "PT", acceptsBitcoin: "onchain" }, `Restaurant in Portugal. Takes Bitcoin on-chain. ${RATED}`],
    ["both", { country: "PT", acceptsBitcoin: "both" }, `Restaurant in Portugal. Takes Bitcoin over Lightning and on-chain. ${RATED}`],
    ["yes", { country: "PT", acceptsBitcoin: "yes" }, `Restaurant in Portugal. Takes Bitcoin. ${RATED}`],
    ["a country code no country has", { country: "XQ" }, `Restaurant. ${RATED}`],
    ["a kind the app does not list, as the app words it", { category: "bubble_tea", country: "PT" }, `Bubble tea in Portugal. ${RATED}`],
    ["a cafe that is a coffee shop, as the app's lists word it", { category: "cafe", cuisine: "coffee_shop", country: "PT" }, `Coffee shop in Portugal. ${RATED}`],
    ["a restaurant, with its cuisine in front", { cuisine: "mexican", country: "PT" }, `Mexican restaurant in Portugal. ${RATED}`],
    ["a kind whose cuisine the app writes after a dot, by its kind alone", { category: "food_court", cuisine: "sushi", country: "PT" }, `Food court in Portugal. ${RATED}`],
  ])("is described by what is known of it: %s", (_, over, description) => {
    const place = make("Casa", over);
    const indexes = buildIndexes([place], towns);
    expect(placeDescription(place, indexes)).toBe(description);
    expect(headOf(pageAt(pagesOf([place]), `place/${place.d}.html`).html).description).toBe(description);
  });

  it("names its town as the app labels it: with its state when two towns share its name, and never its country twice", () => {
    const kentucky = make("Kentucky Coffee", { lat: 38.04, lon: -84.5, country: "US" });
    const virginia = make("Virginia Coffee", { lat: 37.78, lon: -79.44, country: "US" });
    const spain = make("Horchateria", { lat: 39.47, lon: -0.37, country: "ES" });
    const venezuela = make("Arepera", { lat: 10.16, lon: -68.0, country: "VE" });
    const indexes = buildIndexes([kentucky, virginia, spain, venezuela], towns);

    expect(placeDescription(kentucky, indexes)).toBe(`Restaurant in Lexington, KY, United States. ${RATED}`);
    expect(placeDescription(virginia, indexes)).toBe(`Restaurant in Lexington, VA, United States. ${RATED}`);
    expect(placeDescription(spain, indexes)).toBe(`Restaurant in Valencia, Spain. ${RATED}`);
    expect(placeDescription(venezuela, indexes)).toBe(`Restaurant in Valencia, Venezuela. ${RATED}`);
  });

  it("shows the place's own picture when it is at an https: address, and the Regulars card otherwise", () => {
    const own = make("Own", { image: "https://images.example/own.jpg" });
    const plain = make("Plain", { image: "http://images.example/plain.jpg" });
    const broken = make("Broken", { image: "not an address" });
    const none = make("None");
    const pages = pagesOf([own, plain, broken, none]);
    const imageOf = (place: Place) => headOf(pageAt(pages, `place/${place.d}.html`).html).image;

    expect(imageOf(own)).toBe("https://images.example/own.jpg");
    expect(imageOf(plain)).toBe(CARD);
    expect(imageOf(broken)).toBe(CARD);
    expect(imageOf(none)).toBe(CARD);
  });

  it("is at the file a host that decodes the request's path looks up, while its address stays the app's link", () => {
    const place = make("Café", { d: "café 1%" });
    const page = pageAt(pagesOf([place]), "place/café 1%.html");
    expect(page.url).toBe("https://askregulars.world/place/caf%C3%A9%201%25");
    expect(page.url).toBe(`${ORIGIN}${placePath("café 1%")}`);
    const head = headOf(page.html);
    expect(head.url).toBe(page.url);
    expect(head.canonical).toBe(page.url);
  });

  it("is not made for a d that cannot be a file of the site, and is for one that only holds dots", () => {
    const unsafe = ["../x", "a/b", "a\\b", "", ".", "..", "a\u0000b", "tab\there", "del\u007f", "c1\u0085"];
    const places = unsafe.map((d) => make("Unsafe", { d }));
    const dots = make("Dots", { d: "a..b" });
    const pages = pagesOf([...places, dots]);

    expect(pages.filter((page) => page.path.startsWith("place/")).map((page) => page.path)).toEqual(["place/a..b.html"]);
  });

  it("is not made for a d that ends in .html, in any case: a host would answer its address with the page of the place without it", () => {
    const plain = make("Plain", { d: "x" });
    const endings = ["x.html", "x.HTML", "x.Html", ".html", "x%2Ehtml"].map((d) => make("Ending", { d }));
    const paths = pagesOf([plain, ...endings]).filter((page) => page.path.startsWith("place/")).map((page) => page.path);

    expect(paths).toEqual(["place/x.html", "place/x%2Ehtml.html"]);
  });

  it("is not made for a d whose file's name would be longer than 255 bytes, counted as UTF-8 with its .html", () => {
    const longest = make("Longest", { d: "x".repeat(250) });
    const tooLong = make("Too long", { d: "x".repeat(251) });
    // 126 characters, but 252 bytes: with .html, 257.
    const wide = make("Wide", { d: "é".repeat(126) });
    const fits = make("Fits", { d: "é".repeat(125) });
    const paths = pagesOf([longest, tooLong, wide, fits]).filter((page) => page.path.startsWith("place/")).map((page) => page.path);

    expect(paths).toEqual([`place/${"x".repeat(250)}.html`, `place/${"é".repeat(125)}.html`]);
  });

  it("is skipped for a d that cannot be written as an address, and the other pages are still made", () => {
    const broken = make("Broken", { d: "lone\ud800surrogate" });
    const fine = make("Fine", { d: "osm-node-5" });
    const paths = pagesOf([broken, fine]).filter((page) => page.path.startsWith("place/")).map((page) => page.path);

    expect(paths).toEqual(["place/osm-node-5.html"]);
  });

  it("is made once for a d two places share, for the place the app opens there", () => {
    const first = make("First", { d: "osm-node-7" });
    const second = make("Second", { d: "osm-node-7" });
    const pages = pagesOf([first, second]).filter((page) => page.path.startsWith("place/"));

    expect(pages).toHaveLength(1);
    expect(headOf(pages[0]!.html).title).toBe("First · Regulars");
  });
});

describe("a chain's page", () => {
  /** Four places of one name in Portugal, the one place of it elsewhere, and a place of another name. */
  const confeitaria = [1, 2, 3, 4].map((i) => make("A Confeitaria Coffee & Bakery", { lat: 32.65 + i / 1000, lon: -16.9, country: "PT" }));
  const places = [...confeitaria, make("A Confeitaria Coffee & Bakery", { country: "ES" }), make("Somewhere else", { country: "PT" })];

  it("is at the chain's address, titled after the chain, with how many locations it has and where", () => {
    const indexes = buildIndexes(places, towns);
    const chain = [...indexes.chains.values()].find((each) => each.country === "PT")!;
    const page = pageAt(pagesOf(places), "chain/PT:a confeitaria coffee & bakery.html");
    expect(page.url).toBe(`${ORIGIN}/chain/${chainSlug(chain)}`);

    const head = headOf(page.html);
    expect(head.title).toBe("A Confeitaria Coffee & Bakery · Regulars");
    expect(head.title).toBe(copy.titles.chain(chain.name));
    expect(head.ogTitle).toBe(head.title);
    expect(head.description).toBe(`4 locations in Portugal. ${RATED}`);
    expect(chainDescription(chain)).toBe(head.description);
    expect(head.ogDescription).toBe(head.description);
    expect(head.url).toBe("https://askregulars.world/chain/PT:a%20confeitaria%20coffee%20%26%20bakery");
    expect(head.url).toBe(page.url);
    expect(head.canonical).toBe(head.url);
    expect(head.image).toBe(CARD);
  });

  it("is made for every chain the app has, and only for them", () => {
    const pages = pagesOf(places);
    const chains = [...buildIndexes(places, towns).chains.values()];
    expect(chains).toHaveLength(1);
    expect(pages.filter((page) => page.path.startsWith("chain/")).map((page) => page.path)).toEqual(chains.map((chain) => `chain/${chain.country}:${chain.key}.html`));
  });

  it("says no country for a chain whose places have none", () => {
    const chain: Chain = { key: "nowhere", country: "", name: "Nowhere", places: [make("Nowhere"), make("Nowhere")] };
    expect(chainDescription(chain)).toBe(`2 locations. ${RATED}`);
  });

  it("is not made for a chain whose name cannot be a file of the site", () => {
    const slashed = [make("A/B Cafe", { country: "PT" }), make("A/B Cafe", { country: "PT" })];
    expect(buildIndexes(slashed, towns).chains.size).toBe(1);
    expect(pagesOf(slashed).filter((page) => page.path.startsWith("chain/"))).toEqual([]);
  });

  it("is not made for a chain whose name ends in .html, in any case: a host would answer its address with another chain's page", () => {
    const ending = [make("Cafe.HTML", { country: "PT" }), make("Cafe.HTML", { country: "PT" })];
    expect([...buildIndexes(ending, towns).chains.values()].map((chain) => chain.key)).toEqual(["cafe.html"]);
    expect(pagesOf(ending).filter((page) => page.path.startsWith("chain/"))).toEqual([]);
  });

  it("is skipped for a chain whose name cannot be written as an address, and its places' pages are still made", () => {
    const broken = [make("Lone \ud800 Cafe", { country: "PT" }), make("Lone \ud800 Cafe", { country: "PT" })];
    const pages = pagesOf(broken);
    expect(pages.filter((page) => page.path.startsWith("chain/"))).toEqual([]);
    expect(pages.filter((page) => page.path.startsWith("place/"))).toHaveLength(2);
  });
});

describe("the fixed pages", () => {
  const FIXED: [path: string, title: string][] = [
    ["/trending", "Trending · Regulars"],
    ["/about", "About · Regulars"],
    ["/why", "Why you see what you see · Regulars"],
    ["/map", "Map · Regulars"],
    ["/search", "Search · Regulars"],
    ["/you", "You · Regulars"],
    ["/saved", "Saved · Regulars"],
    ["/signin", "Sign in · Regulars"],
  ];

  it.each(FIXED)("%s has its page, with the app's title for it and the app's own description", (path, title) => {
    const head = headOf(pageAt(pagesOf([]), `${path.slice(1)}.html`).html);
    expect(head.title).toBe(title);
    expect(head.ogTitle).toBe(title);
    expect(head.description).toBe(copy.meta.description);
    expect(head.ogDescription).toBe(copy.meta.description);
    expect(head.url).toBe(`https://askregulars.world${path}`);
    expect(head.canonical).toBe(head.url);
    expect(pageAt(pagesOf([]), `${path.slice(1)}.html`).url).toBe(head.url);
    expect(head.image).toBe(CARD);
  });

  it("are pages of the app, at the addresses its routes give them", () => {
    const routePaths = new Set<string>();
    const walk = (list: typeof routes) => {
      for (const route of list) {
        if (route.path !== undefined) routePaths.add(`/${route.path}`);
        if (route.children !== undefined) walk(route.children);
      }
    };
    walk(routes);
    for (const [path] of FIXED) expect(routePaths).toContain(path);
  });

  it("are all there is besides the places and chains: a reviewer's page, a review form, Filters and Recent get none", () => {
    const place = make("Casa", { d: "osm-node-1" });
    const pages = pagesOf([place, make("Twin", { country: "PT" }), make("Twin", { country: "PT" })]);
    const fixed = FIXED.map(([path]) => `${path.slice(1)}.html`);
    const places = pages.filter((page) => page.path.startsWith("place/")).map((page) => page.path);
    const chains = pages.filter((page) => page.path.startsWith("chain/")).map((page) => page.path);

    expect(places).toHaveLength(3);
    expect(chains).toEqual(["chain/PT:twin.html"]);
    expect(pages.map((page) => page.path).sort()).toEqual([...fixed, ...places, ...chains].sort());
    for (const page of pages) {
      expect(page.path).toMatch(/\.html$/);
      expect(page.path).not.toMatch(/^(person|filters|recent)[/.]/);
      expect(page.path).not.toMatch(/\/review\.html$/);
    }
  });
});

describe("what a list's names and towns can do to a page", () => {
  const HOSTILE = `"><script>alert(1)</script>&`;
  // A chain's name with markup in it: one with a slash, as HOSTILE has, gets no chain page.
  const HOSTILE_CHAIN = `'"><b onmouseover=alert(2)>&`;

  it("ends as text in the title, every tag and the description, and adds no element", () => {
    // Two of a name in a country make a chain: its page is named so too.
    const places = [
      make(HOSTILE, { region: HOSTILE, country: "PT" }),
      make(HOSTILE, { region: HOSTILE, country: "PT" }),
      make(HOSTILE_CHAIN, { country: "PT" }),
      make(HOSTILE_CHAIN, { country: "PT" }),
    ];
    const pages = pagesOf(places);
    const written = pages.filter((page) => page.path.startsWith("place/") || page.path.startsWith("chain/"));
    expect(written.map((page) => page.path)).toEqual([...places.map((place) => `place/${place.d}.html`), `chain/PT:${HOSTILE_CHAIN}.html`]);

    const fixture = new DOMParser().parseFromString(INDEX_HTML, "text/html");
    for (const page of written) {
      const head = headOf(page.html);
      expect([`${HOSTILE} · Regulars`, `${HOSTILE_CHAIN} · Regulars`]).toContain(head.title);
      expect(head.ogTitle).toBe(head.title);
      expect(scriptsOf(page.html)).toEqual(scriptsOf(INDEX_HTML));
      expect(head.doc.querySelectorAll("script")).toHaveLength(2);
      expect(head.doc.querySelectorAll("b")).toHaveLength(0);
      // Seven tags of the preview and the canonical address are added; the description is replaced.
      expect(head.doc.querySelectorAll("meta, link")).toHaveLength(fixture.querySelectorAll("meta, link").length + 8);
      expect(head.doc.querySelectorAll("*")).toHaveLength(fixture.querySelectorAll("*").length + 8);
      expect(page.html).not.toContain("<script>alert");
      expect(page.html).not.toContain("<b ");
    }
    const place = pageAt(pages, `place/${places[0]!.d}.html`);
    expect(place.html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;");
    const head = headOf(place.html);
    expect(head.description).toBe(`Restaurant in ${HOSTILE}, Portugal. ${RATED}`);
    expect(head.ogDescription).toBe(head.description);
  });

  it.each([
    ["an escape written out", "Tom &amp; Jerry's"],
    ["an emoji", "☕ Café do Largo"],
    ["right-to-left text", "مقهى الحي"],
    ["what a string's replace would read as a pattern", "$& $' $` $$ $1"],
  ])("keeps %s as it is", (_, name) => {
    const place = make(name);
    const head = headOf(pageAt(pagesOf([place]), `place/${place.d}.html`).html);
    expect(head.title).toBe(`${name} · Regulars`);
    expect(head.ogTitle).toBe(`${name} · Regulars`);
  });
});

describe("withHead", () => {
  const FIELDS = { title: "Jacafé · Regulars", description: "Cafe.", image: CARD, url: `${ORIGIN}/place/x` };

  it("throws for a page with no title, or no end to its head", () => {
    expect(() => withHead(INDEX_HTML.replace("<title>Regulars</title>", ""), FIELDS)).toThrow(/title/);
    expect(() => withHead(INDEX_HTML.replace("</head>", ""), FIELDS)).toThrow(/head/);
  });

  it("throws for a tag found under two of the names it writes: which to write there is not clear", () => {
    const both = INDEX_HTML.replace('<meta name="description"', '<meta property="og:description" name="description"');
    expect(() => withHead(both, FIELDS)).toThrow(/og:description/);
  });

  it("throws for a page with two titles, or two descriptions: which to replace is not clear", () => {
    expect(() => withHead(INDEX_HTML.replace("<title>Regulars</title>", "<title>A</title><title>B</title>"), FIELDS)).toThrow(/title/);
    const twice = INDEX_HTML.replace(/(<meta name="description"[^>]*>)/, "$1$1");
    expect(() => withHead(twice, FIELDS)).toThrow(/description/);
  });

  it("keeps the policy, every script and the body byte for byte", () => {
    const html = withHead(INDEX_HTML, FIELDS);
    const policy = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(INDEX_HTML)![0];
    expect(html).toContain(policy);
    expect(html.indexOf(policy)).toBeLessThan(html.indexOf("<title>"));
    expect(scriptsOf(html)).toEqual(scriptsOf(INDEX_HTML));
    expect(html.slice(html.indexOf("</head>"))).toBe(INDEX_HTML.slice(INDEX_HTML.indexOf("</head>")));
    // Nothing else in the head changed: taking out what was written leaves the page it was given, but
    // for its title and description.
    const written = /^ *<(?:meta (?:property="og:|name="twitter:)|link rel="canonical")[^\n]*\n/gm;
    expect(html.replace(written, "")).toBe(
      INDEX_HTML.replace("<title>Regulars</title>", "<title>Jacafé · Regulars</title>").replace(
        `content="${copy.meta.description}"`,
        'content="Cafe."',
      ),
    );
  });

  it("finds the title and description however the build writes them", () => {
    const reworded = INDEX_HTML.replace("<title>Regulars</title>", '<TITLE data-x="a>b">Regulars</TITLE>').replace(
      /<meta name="description" content="[^"]*" \/>/,
      "<meta content='Old description' NAME=description>",
    );
    const head = headOf(withHead(reworded, FIELDS));
    expect(head.title).toBe(FIELDS.title);
    expect(head.description).toBe(FIELDS.description);

    // A page with no description is given one with the rest.
    const undescribed = INDEX_HTML.replace(/ *<meta name="description"[^\n]*\n/, "");
    expect(headOf(withHead(undescribed, FIELDS)).description).toBe(FIELDS.description);
  });

  it("replaces the preview tags a page has already, as the home page has, rather than adding a second of each", () => {
    const home = withHead(INDEX_HTML, { title: "Regulars", description: copy.meta.description, image: CARD, url: `${ORIGIN}/` });
    const head = headOf(withHead(home, FIELDS));
    expect(head.title).toBe(FIELDS.title);
    expect(head.ogTitle).toBe(FIELDS.title);
    expect(head.ogDescription).toBe("Cafe.");
    expect(head.url).toBe(FIELDS.url);
    expect(head.canonical).toBe(FIELDS.url);
  });

  it("leaves alone a title or an end of the head in a comment", () => {
    const commented = INDEX_HTML.replace("<title>Regulars</title>", "<!-- <title>Old</title> </head> --><title>Regulars</title>");
    const html = withHead(commented, FIELDS);
    expect(html).toContain("<!-- <title>Old</title> </head> -->");
    expect(headOf(html).title).toBe(FIELDS.title);
    expect(html.slice(html.indexOf("  </head>"))).toBe(INDEX_HTML.slice(INDEX_HTML.indexOf("  </head>")));
  });
});

describe("the sitemap and robots.txt", () => {
  const places = [make("Casa", { d: "café 1%" }), make("Twin", { country: "PT" }), make("Twin", { country: "PT" })];
  const pages = pagesOf(places);

  it("lists the home page and every page's address once, as valid XML", () => {
    const xml = sitemap(pages, ORIGIN);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.namespaceURI).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
    const locs = [...doc.getElementsByTagName("loc")].map((loc) => loc.textContent);
    expect(locs).toEqual([`${ORIGIN}/`, ...pages.map((page) => page.url)]);
    expect(pages.map((page) => page.url)).toEqual(pages.map((page) => headOf(page.html).canonical));
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs).toContain("https://askregulars.world/place/caf%C3%A9%201%25");
    expect(locs).toContain("https://askregulars.world/chain/PT:twin");
  });

  it("reads each page's address from the page, not from its file's name", () => {
    const page: SharePage = { path: "place/a b.html", url: `${ORIGIN}/place/a%20b`, html: "" };
    expect(sitemap([page], ORIGIN)).toContain("<loc>https://askregulars.world/place/a%20b</loc>");
  });

  it("puts each page at the file a host that decodes the request's path once looks up for its address", () => {
    for (const page of pages) expect(`${decodeURIComponent(new URL(page.url).pathname).slice(1)}.html`).toBe(page.path);
  });

  it("robots.txt lets everything be read and names the sitemap", () => {
    expect(robotsTxt(ORIGIN)).toBe("User-agent: *\nAllow: /\nSitemap: https://askregulars.world/sitemap.xml\n");
  });
});

describe("what a preview says of a place's rating, or of a person", () => {
  it("says no rating and no number, but a chain's count of its locations", () => {
    const places = [
      make("Casa", { ...FUNCHAL, country: "PT", acceptsBitcoin: "both", image: "https://images.example/a.jpg" }),
      make("Twin", { country: "PT" }),
      make("Twin", { country: "PT" }),
    ];
    for (const page of pagesOf(places)) {
      const head = headOf(page.html);
      const said = [head.title, head.ogTitle, head.description, head.ogDescription].join(" ");
      expect(said).not.toMatch(/★|☆|\bstars?\b|\brating\b|\bscore|\brank|\bweight|%|\bpeople have\b|\bothers\b/i);
      const numbers = said.match(/\d+/g) ?? [];
      expect(numbers).toEqual(page.path.startsWith("chain/") ? ["2", "2"] : []);
    }
  });
});
