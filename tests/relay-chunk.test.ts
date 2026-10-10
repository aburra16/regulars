// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// Reading a relay loads Nostrify and what it brings (zod, websocket-ts): 65 KB gzip that the first
// screen must not wait for. src/nostr/relayReader.ts holds that code, and the places store and the
// scores store each reach it only through a dynamic import() (src/places/store.tsx,
// src/score/store.ts), so the build gives it a chunk of its own, fetched when a relay is first read.
// Posting a review sends it through the same relay code, loaded the same way (src/review/post.ts).
// Signing in loads Nostrify too, and the keys of nostr-tools: src/account/connect.ts holds that code,
// which the account provider reaches only through a dynamic import() (src/account/AccountProvider.tsx),
// and Nostrify is then a chunk the two share. The phone's way of signing in on the sign-in page, with
// the QR code's library (uqr), is a chunk the sign-in page fetches (src/signin/loadPhoneWay.ts); the
// add-on's way, which the sign-in page and Rate this place take at once, loads only the signing code.
// Brainstorm's client, which works out a person's circle (src/circle/brainstorm.ts), is a chunk of its
// own too: one module imports it, through a dynamic import() (src/circle/loadBrainstorm.ts), which the
// circle's provider (src/circle/CircleProvider.tsx) and the Why page's count (src/circle/circleSize.ts)
// call when they first need it: the person taps Personalize or Update now, a signed-in tab looks for a
// circle worked out before, or the Why page counts the circle with the token the tab has.
// The check of a fresh list's signatures (src/places/signatures.ts) is a chunk the places store loads
// when the relay's list comes, and nostr-tools' signature code (@noble/curves) is in none the entry loads.
// This builds the real app (vite.config.ts and index.html, in memory: nothing is written) and checks
// that none of it is in the entry, or in anything the entry loads before it runs.
const ROOT = process.cwd();
const RELAY_READER = /[\\/]src[\\/]nostr[\\/]relayReader\.ts$/;
const NOSTRIFY = /[\\/]node_modules[\\/]@nostrify[\\/]/;
const SCORES_STORE = /[\\/]src[\\/]score[\\/]store\.ts$/;
const ACCOUNT_PROVIDER = /[\\/]src[\\/]account[\\/]AccountProvider\.tsx$/;
const POST = /[\\/]src[\\/]review[\\/]post\.ts$/;
const CONNECT = /[\\/]src[\\/]account[\\/]connect\.ts$/;
const QR_LIBRARY = /[\\/]node_modules[\\/]uqr[\\/]/;
const BRAINSTORM = /[\\/]src[\\/]circle[\\/]brainstorm\.ts$/;
const CIRCLE_PROVIDER = /[\\/]src[\\/]circle[\\/]CircleProvider\.tsx$/;
const SIGNATURES = /[\\/]src[\\/]places[\\/]signatures\.ts$/;
const CURVES = /[\\/]node_modules[\\/]@noble[\\/]curves[\\/]/;

type Output = Awaited<ReturnType<typeof build>>;
interface Chunk {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
}

function chunksOf(result: Output): Chunk[] {
  const results = Array.isArray(result) ? result : [result];
  return results
    .flatMap((r) => ("output" in r ? r.output : []))
    .flatMap((file) =>
      file.type === "chunk"
        ? [
            {
              fileName: file.fileName,
              isEntry: file.isEntry,
              isDynamicEntry: file.isDynamicEntry,
              imports: file.imports,
              dynamicImports: file.dynamicImports,
              moduleIds: file.moduleIds,
            },
          ]
        : [],
    );
}

describe("the relay chunk", () => {
  it("holds the relay code and Nostrify, loaded on demand, and none of it is in the entry", async () => {
    const chunks = chunksOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false },
      }),
    );
    const lazyCode = (chunk: Chunk | undefined) =>
      (chunk?.moduleIds ?? []).filter((id) => [RELAY_READER, NOSTRIFY, CONNECT, QR_LIBRARY, BRAINSTORM, SIGNATURES, CURVES].some((code) => code.test(id)));

    const entries = chunks.filter((chunk) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The scores store and the account provider are in the app's first screen (main.tsx mounts them),
    // so this checks what they import.
    expect(entry.moduleIds.some((id) => SCORES_STORE.test(id))).toBe(true);
    expect(entry.moduleIds.some((id) => ACCOUNT_PROVIDER.test(id))).toBe(true);
    // So is the review form, which posts through the relay code it loads when the person posts.
    expect(entry.moduleIds.some((id) => POST.test(id))).toBe(true);
    // And the circle's provider, which loads Brainstorm's client when it is first needed.
    expect(entry.moduleIds.some((id) => CIRCLE_PROVIDER.test(id))).toBe(true);
    expect(lazyCode(entry)).toEqual([]);

    // Everything the entry loads before it runs: none of it is the relay code, Nostrify, the signing code,
    // the QR library, Brainstorm's client, the signature check or the curves it checks with.
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = new Set<string>([entry.fileName]);
    for (const name of eager) for (const imported of byName.get(name)?.imports ?? []) eager.add(imported);
    expect([...eager].flatMap((name) => lazyCode(byName.get(name)))).toEqual([]);

    /** The chunk that holds `code`: one, which the entry imports when it is first needed. */
    const lazyChunkOf = (code: RegExp) => {
      const holding = chunks.filter((chunk) => chunk.moduleIds.some((id) => code.test(id)));
      expect(holding).toHaveLength(1);
      expect(holding[0]?.isDynamicEntry).toBe(true);
      expect(entry.dynamicImports).toContain(holding[0]?.fileName);
      return holding[0]!;
    };
    /** Whether `chunk`, or a chunk it loads before it runs, holds Nostrify. */
    const bringsNostrify = (chunk: Chunk) =>
      [chunk, ...chunk.imports.map((name) => byName.get(name))].some((each) => each?.moduleIds.some((id) => NOSTRIFY.test(id)));

    // The relay code, and the signing code, each in a chunk of its own, which brings Nostrify.
    expect(bringsNostrify(lazyChunkOf(RELAY_READER))).toBe(true);
    expect(bringsNostrify(lazyChunkOf(CONNECT))).toBe(true);
    // The QR library, in the chunk of the phone's way.
    lazyChunkOf(QR_LIBRARY);
    // Brainstorm's client, in a chunk of its own, which brings no Nostrify: it signs through the account's signer.
    expect(bringsNostrify(lazyChunkOf(BRAINSTORM))).toBe(false);
    // The signature check, in a chunk of its own, which brings no Nostrify either.
    expect(bringsNostrify(lazyChunkOf(SIGNATURES))).toBe(false);
  }, 120_000);
});
