// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// Reading a relay loads Nostrify and what it brings (zod, websocket-ts): 65 KB gzip that the first
// screen must not wait for. src/nostr/relayReader.ts holds that code, and the places store and the
// scores store each reach it only through a dynamic import() (src/places/store.tsx,
// src/score/store.ts), so the build gives it a chunk of its own, fetched when a relay is first read.
// This builds the real app (vite.config.ts and index.html, in memory: nothing is written) and checks
// that none of it is in the entry, or in anything the entry loads before it runs.
const ROOT = process.cwd();
const RELAY_READER = /[\\/]src[\\/]nostr[\\/]relayReader\.ts$/;
const NOSTRIFY = /[\\/]node_modules[\\/]@nostrify[\\/]/;
const SCORES_STORE = /[\\/]src[\\/]score[\\/]store\.ts$/;

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
    const relayCode = (chunk: Chunk | undefined) =>
      (chunk?.moduleIds ?? []).filter((id) => RELAY_READER.test(id) || NOSTRIFY.test(id));

    const entries = chunks.filter((chunk) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The scores store is in the app's first screen (main.tsx mounts it), so this checks what it imports.
    expect(entry.moduleIds.some((id) => SCORES_STORE.test(id))).toBe(true);
    expect(relayCode(entry)).toEqual([]);

    // Everything the entry loads before it runs: none of it is the relay code.
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = new Set<string>([entry.fileName]);
    for (const name of eager) for (const imported of byName.get(name)?.imports ?? []) eager.add(imported);
    expect([...eager].flatMap((name) => relayCode(byName.get(name)))).toEqual([]);

    // The relay code is in a chunk of its own, which the entry imports when it first reads a relay.
    const relay = chunks.filter((chunk) => chunk.moduleIds.some((id) => RELAY_READER.test(id)));
    expect(relay).toHaveLength(1);
    expect(relay[0]?.isDynamicEntry).toBe(true);
    expect(relay[0]?.moduleIds.some((id) => NOSTRIFY.test(id))).toBe(true);
    expect(entry.dynamicImports).toContain(relay[0]?.fileName);
  }, 120_000);
});
