// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// The towns the places are put in (src/data/towns.json, about 145 KB) load with the places, not with
// the first screen's code: src/places/towns.ts reaches the file only through a dynamic import()
// (`loadTowns`), which the places store calls when it starts loading the places. This builds the real
// app (vite.config.ts and index.html, in memory: nothing is written) and checks that the file is a
// chunk of its own, and that neither the entry nor anything it loads before it runs holds it.
const ROOT = process.cwd();
const TOWNS = /[\\/]src[\\/]data[\\/]towns\.json$/;
const TOWNS_CODE = /[\\/]src[\\/]places[\\/]towns\.ts$/;
/** A line of the file that only the file has: what it says of where it comes from. */
const TOWNS_TEXT = "cut down by tools/towns.ts";

type Output = Awaited<ReturnType<typeof build>>;
interface Chunk {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
  code: string;
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
              code: file.code,
            },
          ]
        : [],
    );
}

describe("the towns' chunk", () => {
  it("holds the towns, loaded when the places are, and none of them is in the entry", async () => {
    const chunks = chunksOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false },
      }),
    );
    const entries = chunks.filter((chunk) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The code that loads them is in the entry; the towns are not.
    expect(entry.moduleIds.some((id) => TOWNS_CODE.test(id))).toBe(true);
    expect(entry.moduleIds.some((id) => TOWNS.test(id))).toBe(false);

    // Nor in anything the entry loads before it runs.
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = new Set<string>([entry.fileName]);
    for (const name of eager) for (const imported of byName.get(name)?.imports ?? []) eager.add(imported);
    expect([...eager].filter((name) => byName.get(name)?.moduleIds.some((id) => TOWNS.test(id)))).toEqual([]);

    // One chunk holds them, which the entry imports when the places load.
    const holding = chunks.filter((chunk) => chunk.moduleIds.some((id) => TOWNS.test(id)));
    expect(holding).toHaveLength(1);
    expect(holding[0]!.isDynamicEntry).toBe(true);
    expect(entry.dynamicImports).toContain(holding[0]!.fileName);

    // And the text of the file is in that chunk, and in no other.
    expect(chunks.filter((chunk) => chunk.code.includes(TOWNS_TEXT)).map((chunk) => chunk.fileName)).toEqual([holding[0]!.fileName]);
  }, 120_000);
});
