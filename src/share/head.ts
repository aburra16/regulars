/*
 * The head of a page that a link opens before the app runs: the built index.html with its title and
 * description replaced, and the tags a link's preview is read from written in (src/share/pages.ts).
 * Nothing else of the page changes, the security policy and every script among it least of all: the
 * policy holds the hash of the theme's script, and the page is still the app.
 */
import { config } from "../config.ts";

/** What a page's head says of it. Each is plain text, as a person reads it: `withHead` escapes it. */
export interface HeadFields {
  /** The page's title, as the app titles it: "Jacafé · Regulars". */
  title: string;
  description: string;
  /** The full address of the preview's picture. */
  image: string;
  /** The page's own full address. */
  url: string;
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * `text` written so that it reads as itself in an element, in a quoted attribute or in XML: none of
 * it can open a tag, end an attribute or start an entity.
 */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** What in a page is not its markup: its comments, and the text of its scripts and styles. A tag in them is not a tag. */
const NOT_MARKUP = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** A tag's attributes, up to its `>`: a `>` inside a quoted value does not end it. */
const ATTRIBUTES = String.raw`(?:"[^"]*"|'[^']*'|[^'">])*`;

/** The page's title element, its text and all. */
const TITLE = new RegExp(String.raw`<title\b${ATTRIBUTES}>[\s\S]*?<\/title\s*>`, "gi");

/** A meta or link element. */
const META_OR_LINK = new RegExp(String.raw`<(?:meta|link)\b${ATTRIBUTES}>`, "gi");

/** The end of the head. */
const HEAD_END = /<\/head\s*>/gi;

/** An attribute of a tag, with its value when it has one, quoted or not. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A tag the head is given, and the name it is found by: its `name` or `property`, or for a link its `rel`. */
interface Written {
  key: string;
  tag: string;
}

/** The tags of a page's head besides its title, in the order they are added to a page that has none of them. */
function writtenTags({ description, title, image, url }: HeadFields): Written[] {
  const meta = (attribute: "name" | "property", key: string, content: string): Written => ({
    key,
    tag: `<meta ${attribute}="${key}" content="${escapeMarkup(content)}" />`,
  });
  return [
    meta("name", "description", description),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("property", "og:image", image),
    meta("property", "og:url", url),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", config.appName),
    meta("name", "twitter:card", "summary_large_image"),
    { key: "canonical", tag: `<link rel="canonical" href="${escapeMarkup(url)}" />` },
  ];
}

/** The names a meta or link tag is found by, in lower case: a meta's `name` and `property`, a link's `rel`. */
function keysOf(tag: string): string[] {
  const isLink = /^<link\b/i.test(tag);
  const attributes = tag.replace(/^<(?:meta|link)\b/i, "");
  const keys: string[] = [];
  for (const [, name, ...values] of attributes.matchAll(ATTRIBUTE)) {
    const attribute = name!.toLowerCase();
    const value = values.find((each) => each !== undefined)?.trim().toLowerCase();
    if (value !== undefined && (isLink ? attribute === "rel" : attribute === "name" || attribute === "property")) keys.push(value);
  }
  return keys;
}

/** A piece of the page to put in place of `start` to `end`: a tag replaced, or tags added where both are the same. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Where `pattern` matches in `html` before `limit`, leaving out what is in a comment, a script or a style. */
function markupMatches(html: string, pattern: RegExp, limit = html.length): RegExpExecArray[] {
  const hidden = [...html.matchAll(NOT_MARKUP)].map((match) => [match.index, match.index + match[0].length] as const);
  return [...html.matchAll(pattern)].filter(
    (match) => match.index < limit && !hidden.some(([start, end]) => match.index >= start && match.index < end),
  );
}

/**
 * `tags` written in before the end of the head at `index`: each on a line of its own, a step further in
 * than the end, when the end is on a line of its own; else just before it.
 */
function added(html: string, index: number, tags: readonly string[]): Edit {
  const lineStart = html.lastIndexOf("\n", index - 1) + 1;
  const indent = html.slice(lineStart, index);
  if (/^[ \t]*$/.test(indent)) return { start: lineStart, end: lineStart, text: tags.map((tag) => `${indent}  ${tag}\n`).join("") };
  return { start: index, end: index, text: tags.join("") };
}

/**
 * The page `indexHtml` with its head saying `head`: its title replaced, and its description, the
 * tags of a link's preview (`og:`, `twitter:card`) and its canonical address each replaced where the
 * page has one already (the built page has its description) and added before the end of the head
 * where it has not. Everything else is kept as it is, byte for byte. Throws for a page with no title
 * or no end of the head, and for one with two of either, two of a tag it writes, or one tag that is
 * two of them: which to replace would be a guess, and a page written so is not the page the app's
 * build makes.
 */
export function withHead(indexHtml: string, head: HeadFields): string {
  const ends = markupMatches(indexHtml, HEAD_END);
  if (ends.length !== 1) throw new Error(`The page has ${ends.length === 0 ? "no" : "more than one"} </head>, so its head cannot be written`);
  const headEnd = ends[0]!.index;

  const titles = markupMatches(indexHtml, TITLE, headEnd);
  if (titles.length !== 1) throw new Error(`The page's head has ${titles.length === 0 ? "no" : "more than one"} <title>, so it cannot be retitled`);
  const edits: Edit[] = [{ start: titles[0]!.index, end: titles[0]!.index + titles[0]![0].length, text: `<title>${escapeMarkup(head.title)}</title>` }];

  const written = writtenTags(head);
  const writtenKeys = new Set(written.map(({ key }) => key));
  const found = new Map<string, RegExpExecArray[]>();
  for (const match of markupMatches(indexHtml, META_OR_LINK, headEnd)) {
    const keys = [...new Set(keysOf(match[0]))].filter((key) => writtenKeys.has(key));
    // One tag found as two of those written, as `name="description" property="og:description"` is: it
    // would be replaced twice.
    if (keys.length > 1) throw new Error(`A tag of the page's head is both ${keys.join(" and ")}, so it cannot be rewritten`);
    for (const key of keys) found.set(key, [...(found.get(key) ?? []), match]);
  }
  const missing: string[] = [];
  for (const { key, tag } of written) {
    const tags = found.get(key) ?? [];
    if (tags.length > 1) throw new Error(`The page's head has more than one ${key} tag, so it cannot be rewritten`);
    if (tags.length === 1) edits.push({ start: tags[0]!.index, end: tags[0]!.index + tags[0]![0].length, text: tag });
    else missing.push(tag);
  }
  if (missing.length > 0) edits.push(added(indexHtml, headEnd, missing));

  // From the last to the first, so that each edit's place in the page is still where it was found.
  let html = indexHtml;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, start) + text + html.slice(end);
  return html;
}
