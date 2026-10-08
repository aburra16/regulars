/*
 * The third-party notices of the built site: a Vite plugin that writes THIRD_PARTY_NOTICES.txt next to
 * index.html. The licences of the packages the site is built from ask for their notices to go with
 * it, and the minifier drops the comments that carried them, so the build collects them here: for
 * each package that has code, CSS or a font in the output, its name, version, licence and licence text.
 * tests/notices.test.ts builds the site and reads the file.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Plugin } from "vite";

import { NOTICES_FILE } from "../src/about/notices.ts";

/** The folder of the package a module is in: the last `node_modules/<name>` or `node_modules/@scope/<name>` in its path. */
const PACKAGE_ROOT = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;

/** A stylesheet's module id, once its query is off. */
const STYLESHEET = /\.css$/i;

/**
 * An `@import` of a stylesheet, at the start of a rule: `@import "x"`, `@import 'x'`, `@import url("x")`
 * and `@import url(x)`. The specifier is the one group of the three that matched.
 */
const CSS_IMPORT = /(?:^|[;{}])\s*@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]+))/g;

/** A specifier that is a URL, or a path from the site's root: not a package. */
const NOT_A_PACKAGE = /^(?:[a-z][a-z\d+.-]*:|\/)/i;

/** The files a package keeps its licence in. */
const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/**
 * The licence of the packages whose package.json names none, read from their licence file
 * (checked by hand: the text is the licence named here).
 */
const STATED_IN_TEXT: Record<string, string> = {
  "@nostrify/nostrify": "MIT",
  suncalc: "BSD-2-Clause",
};

/** What the notice says of a package beyond its licence. */
const NOTES: Record<string, (files: { libraryChunk?: string }) => string[]> = {
  // docs/decisions.md #13.
  opening_hours: ({ libraryChunk }) => [
    `Ships unmodified, as a file of its own: ${libraryChunk ?? "(not found in this build)"}, with suncalc, the one package it uses.`,
    "The GNU LGPL v3 builds on the GNU GPL v3, at https://www.gnu.org/licenses/gpl-3.0.txt.",
  ],
};

/**
 * Code from packages that is part of the app's own files, with its notice at the top of the file it
 * is in: the minifier drops that comment too.
 */
const ADAPTED = [
  {
    name: "geokdbush-tk",
    version: "2.0.5",
    licence: "ISC",
    source: "https://github.com/mourner/geokdbush",
    file: "src/places/geo.ts",
  },
];

interface Notice {
  name: string;
  version: string;
  licence: string;
  source?: string;
  notes: string[];
  text: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  repository?: string | { url?: string };
  homepage?: string;
}

/** The package a module of the bundle is in, or undefined for the app's own modules. */
function packageRootOf(id: string): string | undefined {
  return PACKAGE_ROOT.exec(id.replace(/^\0/, "").replace(/\?.*$/, ""))?.[1];
}

/**
 * The folder of the package an `@import` names, found as Node finds one: in the `node_modules` of
 * the stylesheet's folder or of the ones above it.
 */
function importedPackageRoot(specifier: string, fromFile: string): string {
  const [first = "", second = ""] = specifier.split("/");
  const name = first.startsWith("@") ? `${first}/${second}` : first;
  for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
    const root = join(dir, "node_modules", name);
    if (existsSync(join(root, "package.json"))) return realpathSync(root);
    if (dirname(dir) === dir) throw new Error(`${fromFile} imports ${specifier}, and no package ${name} is installed for it`);
  }
}

/**
 * The folders of the packages a stylesheet is in or brings in with `@import` (Tailwind's preflight
 * is `@import "tailwindcss"`), and of those the stylesheets it imports by path are in or bring in.
 * No script imports these packages, so the bundle's modules do not name them, and the minifier
 * drops the licence comments in their CSS. The import of a package that is not installed is an
 * error: the build would fail on it too, and a package left out of the notices should never be the
 * quiet outcome. A package named by an `@import` is credited, and its stylesheet is not followed:
 * what that imports is the package's own.
 */
export function packagesImportedByCss(file: string, into = new Set<string>(), seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return into;
  seen.add(file);
  const own = packageRootOf(file);
  if (own !== undefined) into.add(own);
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(CSS_IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    if (specifier === "" || NOT_A_PACKAGE.test(specifier)) continue;
    if (specifier.startsWith(".")) packagesImportedByCss(resolve(dirname(file), specifier), into, seen);
    else into.add(importedPackageRoot(specifier, file));
  }
  return into;
}

function licenceOf(pkg: PackageJson): string | undefined {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type !== undefined) return pkg.license.type;
  const types = (pkg.licenses ?? []).flatMap((each) => (each.type === undefined ? [] : [each.type]));
  return types.length === 0 ? undefined : types.join(" OR ");
}

/** Where a package's source is, as a person can follow it: its repository, without git's own prefixes. */
function sourceOf(pkg: PackageJson): string | undefined {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const clean = url
    ?.replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  return clean ?? pkg.homepage;
}

/** The text of a package's licence: its licence file, or the one named by its licence in a REUSE `LICENSES` folder. */
function licenceTextOf(root: string, licence: string): string {
  const files = readdirSync(root).filter((file) => LICENCE_FILE.test(file)).sort();
  if (files.length > 0) return files.map((file) => readFileSync(join(root, file), "utf8").trim()).join("\n\n");
  const reuse = join(root, "LICENSES", `${licence}.txt`);
  if (existsSync(reuse)) return readFileSync(reuse, "utf8").trim();
  return "(The package has no licence file.)";
}

function packageNotice(root: string, files: { libraryChunk?: string }): Notice {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
  const name = pkg.name ?? root;
  const licence = licenceOf(pkg) ?? STATED_IN_TEXT[name] ?? "not stated; see the text below";
  return {
    name,
    version: pkg.version ?? "",
    licence,
    source: sourceOf(pkg),
    notes: NOTES[name]?.(files) ?? [],
    text: licenceTextOf(root, licence),
  };
}

/** The comment at the top of one of the app's files, without its stars. */
function headerComment(file: string): string {
  const source = readFileSync(file, "utf8");
  const end = source.indexOf("*/");
  if (!source.startsWith("/*") || end === -1) throw new Error(`${file} has no notice at its top`);
  return source
    .slice(2, end)
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

function render(notices: Notice[]): string {
  const intro = [
    "Third-party software in Regulars",
    "",
    "The site is built from the packages below. Each is listed with its version, its licence and the",
    "text of that licence. The app's own code is under the MIT licence (LICENSE in its repository).",
    "",
  ];
  const sections = notices.map((notice) =>
    [
      RULE,
      `${notice.name} ${notice.version}`.trim(),
      `Licence: ${notice.licence}`,
      ...(notice.source === undefined ? [] : [`Source: ${notice.source}`]),
      ...notice.notes,
      THIN,
      notice.text,
      "",
    ].join("\n"),
  );
  return `${[...intro, ...sections].join("\n")}\n`;
}

/**
 * The plugin, for the site's build, and one for each worker's build, whose packages it adds to the
 * site's. A worker is built while the site's modules load, so its packages are known by the time the
 * site's files are written.
 */
export function thirdPartyNotices(projectRoot = process.cwd()): { site: Plugin; worker: () => Plugin } {
  const fromWorkers = new Set<string>();

  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[] }>, into: Set<string>) => {
    for (const file of Object.values(bundle)) {
      if (file.type !== "chunk") continue;
      for (const id of file.moduleIds ?? []) {
        const root = packageRootOf(id);
        if (root !== undefined) into.add(root);
        // A stylesheet's @imports are inlined into it, so the stylesheet alone is a module of the bundle.
        const path = id.replace(/^\0/, "").replace(/\?.*$/, "");
        if (STYLESHEET.test(path) && existsSync(path)) packagesImportedByCss(path, into);
      }
    }
  };

  return {
    worker: () => ({
      name: "regulars:third-party-notices:worker",
      apply: "build",
      generateBundle(_, bundle) {
        collect(bundle, fromWorkers);
      },
    }),
    site: {
      name: "regulars:third-party-notices",
      apply: "build",
      generateBundle(_, bundle) {
        const roots = new Set(fromWorkers);
        collect(bundle, roots);
        const libraryChunk = Object.values(bundle).find(
          (file) => file.type === "chunk" && file.moduleIds.some((id) => /[\\/]node_modules[\\/]opening_hours[\\/]/.test(id)),
        )?.fileName;
        const notices = [...roots].map((root) => packageNotice(root, { libraryChunk }));
        for (const adapted of ADAPTED) {
          notices.push({
            name: adapted.name,
            version: adapted.version,
            licence: adapted.licence,
            source: adapted.source,
            notes: [`Adapted into the app's own code, in ${adapted.file}.`],
            text: headerComment(resolve(projectRoot, adapted.file)),
          });
        }
        notices.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: render(notices) });
      },
    },
  };
}
