// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NOTICES_FILE } from "../src/about/notices";
import { packagesImportedByCss } from "../tools/notices";

// The licences of the packages the site is built from ask for their notices to go with it, and the
// minifier drops the comments that carried them. The build writes them to one file next to the app
// (tools/notices.ts). This builds the real vite.config.ts and index.html in memory, as `npm run build`
// does, and reads the file it would write.
const ROOT = process.cwd();
const NOTICES = NOTICES_FILE;

type Output = Awaited<ReturnType<typeof build>>;

function filesOf(result: Output): { fileName: string; type: string; source?: unknown; moduleIds?: string[] }[] {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap((r) => ("output" in r ? r.output : []));
}

/** The notice of one package: from its line of dashes to the next package's line of equals signs. */
function sectionOf(text: string, name: string): string {
  const start = text.indexOf(`\n${name} `);
  expect(start, `no notice for ${name}`).toBeGreaterThan(-1);
  const end = text.indexOf("\n=====", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

const packageJson = (name: string) =>
  JSON.parse(readFileSync(resolve(ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string };

describe("the third-party notices", () => {
  let text = "";
  let files: ReturnType<typeof filesOf> = [];

  beforeAll(async () => {
    files = filesOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false },
      }),
    );
    const asset = files.find((file) => file.fileName === NOTICES);
    text = typeof asset?.source === "string" ? asset.source : new TextDecoder().decode(asset?.source as Uint8Array);
  }, 60_000);

  it(`is a file at the root of the site, ${NOTICES}`, () => {
    expect(files.map((file) => file.fileName)).toContain(NOTICES);
    expect(text.length).toBeGreaterThan(1000);
  });

  it("names every package the site's code comes from, with its version and licence", () => {
    const bundled = new Set<string>();
    for (const file of files) {
      for (const id of file.moduleIds ?? []) {
        const name = /.*node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1];
        if (name !== undefined) bundled.add(name.replace(/\\/g, "/"));
      }
    }
    expect(bundled.size).toBeGreaterThan(10);
    for (const name of bundled) {
      const section = sectionOf(text, name);
      expect(section).toContain(`${name} ${packageJson(name).version}`);
      expect(section).toMatch(/\nLicence: \S+/);
    }
  });

  it("gives opening_hours its LGPL-3.0 text, and says it ships unmodified as a file of its own", () => {
    const section = sectionOf(text, "opening_hours");
    expect(section).toContain("Licence: LGPL-3.0-only");
    expect(section).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    const chunk = files.find((file) => file.fileName.includes("opening-hours") && file.fileName.endsWith(".js"));
    expect(section).toContain(`Ships unmodified, as a file of its own: ${chunk?.fileName}`);
    expect(section).toContain("https://github.com/opening-hours/opening_hours.js");
  });

  it("gives MapLibre its BSD-3-Clause text", () => {
    const section = sectionOf(text, "maplibre-gl");
    expect(section).toContain("Licence: BSD-3-Clause");
    expect(section).toContain("Redistributions in binary form must reproduce the above copyright notice");
  });

  it("gives each font its Open Font License", () => {
    for (const name of ["@fontsource/figtree", "@fontsource/noto-sans", "@fontsource/noto-sans-jp"]) {
      const section = sectionOf(text, name);
      expect(section).toContain("Licence: OFL-1.1");
      expect(section).toContain("SIL OPEN FONT LICENSE");
    }
  });

  it("credits Tailwind, whose preflight reaches the site through the stylesheet's @import and not through any script", () => {
    const section = sectionOf(text, "tailwindcss");
    expect(section).toContain(`tailwindcss ${packageJson("tailwindcss").version}`);
    expect(section).toContain("Licence: MIT");
    expect(section).toContain("Copyright (c) Tailwind Labs, Inc.");
    expect(section).toContain("Permission is hereby granted, free of charge");
  });

  it("lists each package once, whether a script or a stylesheet brought it", () => {
    const headings = [...text.matchAll(/^={80}\n(\S+)(?: \S*)?$/gm)].map(([, name]) => name);
    expect(headings).toContain("tailwindcss");
    expect(headings).toContain("@fontsource/figtree");
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("names a licence for the packages whose package.json does not, from their licence text", () => {
    expect(sectionOf(text, "@nostrify/nostrify")).toContain("Licence: MIT");
    expect(sectionOf(text, "suncalc")).toContain("Licence: BSD-2-Clause");
  });

  it("keeps the notice of the code adapted into the app's own (geokdbush, ISC)", () => {
    const section = sectionOf(text, "geokdbush-tk");
    expect(section).toContain("Licence: ISC");
    expect(section).toContain("Copyright (c) 2017, Vladimir Agafonkin");
    expect(section).toContain("src/places/geo.ts");
  });
});

// A stylesheet pulls a package in with `@import`, and the minifier drops the licence comment the
// package carried. The notices read the @imports of the site's stylesheets for the packages in them.
describe("the packages a stylesheet imports", () => {
  let dir = "";
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  const rootOf = (name: string) => join(dir, "node_modules", name);

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "regulars-css-")));
    for (const name of ["plain", "quoted", "bare-url", "@scope/pkg", "deep", "after-comment", "layered", "nested"]) {
      write(join("node_modules", name, "package.json"), JSON.stringify({ name }));
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const rootsOf = (file: string) => [...packagesImportedByCss(join(dir, file))].sort();

  it("finds a package by every way a stylesheet can write the @import", () => {
    write(
      "a.css",
      [
        '@import "plain";',
        "@import 'quoted';",
        "@import url(bare-url/x.css);",
        '@import url("@scope/pkg/dist/y.css") screen;',
        '@import "layered" layer(base);',
        "@import",
        '  "deep/z.css";',
      ].join("\n"),
    );
    expect(rootsOf("a.css")).toEqual(["bare-url", "@scope/pkg", "deep", "layered", "plain", "quoted"].map(rootOf).sort());
  });

  it("follows an @import by path into the stylesheet it names, and stops at a loop", () => {
    write("src/b.css", '@import "./parts/c.css";\n@import "../src/b.css";');
    write("src/parts/c.css", '@import "nested";\n@import "../b.css";');
    expect(rootsOf("src/b.css")).toEqual([rootOf("nested")]);
  });

  it("skips what is not an @import of a package: one in a comment or a string, a URL, a path from the site's root", () => {
    write(
      "d.css",
      [
        '/* @import "after-comment"; */',
        '@import url("https://example.com/font.css");',
        '@import "//example.com/font.css";',
        '@import "/public/theme.css";',
        'body::before { content: "@import after-comment;"; }',
      ].join("\n"),
    );
    expect(rootsOf("d.css")).toEqual([]);
  });

  it("counts the package a stylesheet is itself in, and the one an @import by path reaches into", () => {
    write("node_modules/plain/style.css", "a { color: red }");
    write("f.css", '@import "./node_modules/quoted/style.css";');
    write("node_modules/quoted/style.css", "a { color: blue }");
    expect(rootsOf("node_modules/plain/style.css")).toEqual([rootOf("plain")]);
    expect(rootsOf("f.css")).toEqual([rootOf("quoted")]);
  });

  it("is an error when an @import names a package that is not installed, rather than leave it out", () => {
    write("e.css", '@import "not-installed/style.css";');
    expect(() => packagesImportedByCss(join(dir, "e.css"))).toThrow(/not-installed/);
  });
});
