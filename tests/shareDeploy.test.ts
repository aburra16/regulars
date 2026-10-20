import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { withHead } from "../src/share/head";

// The pages a shared link opens are made by a step of the website's deploy (`npm run share-pages`,
// tools/share-pages.ts), after the build and before the copy of the app's page to 404.html, and again
// each day, so new places get theirs. The Android release and the nSite are built without them. The
// home page carries the preview tags of the pages the step makes, with its own values, but for the
// two that name a page's address: 404.html is a copy of it, and answers for addresses that are not it.

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** The commands a workflow runs, in order: each step's `run:`. */
const commandsOf = (workflow: string) => [...workflow.matchAll(/^\s*(?:-\s+)?run:\s*(.+?)\s*$/gm)].map(([, command]) => command!);

/** The block of a workflow's `on:`, the events that start it. */
const triggersOf = (workflow: string) => /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(workflow)?.[1] ?? "";

describe("the website's deploy", () => {
  const deploy = read(".github/workflows/deploy.yml");

  it("writes the pages after the build and before the copy of the app's page to 404.html", () => {
    const commands = commandsOf(deploy);
    const build = commands.indexOf("npm run build");
    const share = commands.indexOf("npm run share-pages");
    const fallback = commands.indexOf("cp dist/index.html dist/404.html");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(share).toBe(build + 1);
    expect(fallback).toBe(share + 1);
    expect(commands.filter((command) => command.includes("share-pages"))).toEqual(["npm run share-pages"]);
  });

  it("runs every day as well as on a push to main", () => {
    const triggers = triggersOf(deploy);
    expect(triggers).toMatch(/^  push:\n    branches: \[main\]$/m);
    expect(triggers).toMatch(/^  schedule:\n    - cron: "17 4 \* \* \*"$/m);
  });

  it("is the step npm runs as share-pages", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(scripts["share-pages"]).toBe("node tools/share-pages.ts");
    expect(scripts.build).not.toContain("share-pages");
  });
});

describe("the Android release", () => {
  it("never writes the pages: Pakstr publishes the app and the nSite from the build alone", () => {
    expect(read(".github/workflows/android-release.yml")).not.toContain("share-pages");
  });
});

describe("the home page's preview", () => {
  const html = read("index.html");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const content = (selector: string) => [...doc.head.querySelectorAll(selector)].map((tag) => tag.getAttribute("content"));

  it("is the seven tags of the pages that name no address, with the home page's own values", () => {
    expect(content('meta[name="description"]')).toEqual([copy.meta.description]);
    expect(content('meta[property="og:title"]')).toEqual([config.appName]);
    expect(content('meta[property="og:description"]')).toEqual([copy.meta.description]);
    expect(content('meta[property="og:image"]')).toEqual([`https://${config.domain}/og-card.png`]);
    expect(content('meta[property="og:type"]')).toEqual(["website"]);
    expect(content('meta[property="og:site_name"]')).toEqual([config.appName]);
    expect(content('meta[name="twitter:card"]')).toEqual(["summary_large_image"]);
  });

  it("names no address of its own: 404.html, a copy of it, opens every address that has no page", () => {
    expect(doc.head.querySelectorAll('meta[property="og:url"]')).toHaveLength(0);
    expect(doc.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(0);
  });

  it("has no other preview tag, which each page would carry unchanged", () => {
    const previewTags = [...doc.head.querySelectorAll("meta")]
      .map((meta) => meta.getAttribute("property") ?? meta.getAttribute("name") ?? "")
      .filter((key) => /^(og|twitter|article|fb|al):/i.test(key));
    expect(previewTags.sort()).toEqual(["og:description", "og:image", "og:site_name", "og:title", "og:type", "twitter:card"]);
  });

  it("is replaced on a page made from it, not doubled, and the page names its own address once", () => {
    const page = withHead(html, {
      title: "Jacafé · Regulars",
      description: "Coffee shop in Funchal, Portugal.",
      image: `https://${config.domain}/og-card.png`,
      url: `https://${config.domain}/place/osm-node-1`,
    });
    const made = new DOMParser().parseFromString(page, "text/html");
    for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:url"]', 'link[rel="canonical"]']) {
      expect(made.head.querySelectorAll(selector), selector).toHaveLength(1);
    }
    expect(made.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(`https://${config.domain}/place/osm-node-1`);
    expect(made.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(`https://${config.domain}/place/osm-node-1`);
    // The home page's seven are replaced; og:url is added.
    expect(made.head.querySelectorAll("meta").length).toBe(doc.head.querySelectorAll("meta").length + 1);
  });
});
