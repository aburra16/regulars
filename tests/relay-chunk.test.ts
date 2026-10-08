// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// Reading a relay loads Nostrify and what it brings (zod, websocket-ts): 65 KB gzip that the first
// screen must not wait for. src/nostr/relayReader.ts holds that code, and the places store and the
// scores store each reach it only through a dynamic import() (src/places/store.tsx,
// src/score/store.ts), so the build gives it a chunk of its own, fetched when a relay is first read.
// Signing in loads Nostrify too, and the keys of nostr-tools: src/account/connect.ts holds that code,
// which the account provider reaches only through a dynamic import() (src/account/AccountProvider.tsx),
// and Nostrify is then a chunk the two share. What Continue opens on the sign-in page, with the QR
// code's library (uqr), is a chunk the sign-in page fetches (src/signin/SignInPage.tsx).
// This builds the real app (vite.config.ts and index.html, in memory: nothing is written) and checks
// that none of it is in the entry, or in anything the entry loads before it runs.
const ROOT = process.cwd();
const RELAY_READER = /[\\/]src[\\/]nostr[\\/]relayReader\.ts$/;
const NOSTRIFY = /[\\/]node_modules[\\/]@nostrify[\\/]/;
const SCORES_STORE = /[\\/]src[\\/]score[\\/]store\.ts$/;
const ACCOUNT_PROVIDER = /[\\/]src[\\/]account[\\/]AccountProvider\.tsx$/;
const CONNECT = /[\\/]src[\\/]account[\\/]connect\.ts$/;
const QR_LIBRARY = /[\\/]node_modules[\\/]uqr[\\/]/;

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
      (chunk?.moduleIds ?? []).filter((id) => [RELAY_READER, NOSTRIFY, CONNECT, QR_LIBRARY].some((code) => code.test(id)));

    const entries = chunks.filter((chunk) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The scores store and the account provider are in the app's first screen (main.tsx mounts them),
    // so this checks what they import.
    expect(entry.moduleIds.some((id) => SCORES_STORE.test(id))).toBe(true);
    expect(entry.moduleIds.some((id) => ACCOUNT_PROVIDER.test(id))).toBe(true);
    expect(lazyCode(entry)).toEqual([]);

    // Everything the entry loads before it runs: none of it is the relay code, Nostrify, the signing code or the QR library.
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
    // The QR library, in the chunk of what Continue opens.
    lazyChunkOf(QR_LIBRARY);
  }, 120_000);
});
