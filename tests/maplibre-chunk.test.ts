// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// MapLibre is about 1 MB. The pages without a map must not fetch it, so BaseMap imports it when a
// map is first drawn, and the build puts it in a chunk of its own. This builds the real
// vite.config.ts (in memory, nothing is written) from an entry that draws a map, and checks that.
const ROOT = process.cwd();
const ENTRY = resolve(ROOT, "tests/support/map-entry.ts");
const MAPLIBRE = /[\\/]node_modules[\\/]maplibre-gl[\\/]/;

type Output = Awaited<ReturnType<typeof build>>;
interface Chunk {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
}

function outputOf(result: Output) {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap((r) => ("output" in r ? r.output : []));
}

describe("the map library's chunk", () => {
  it("is loaded by the map when it is drawn, and none of it is in the entry", async () => {
    const files = outputOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false, rolldownOptions: { input: ENTRY } },
      }),
    );
    const chunks: Chunk[] = files.flatMap((file) =>
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

    const entry = chunks.find((chunk) => chunk.isEntry)!;
    expect(entry.moduleIds.filter((id) => MAPLIBRE.test(id))).toEqual([]);

    // Everything the entry loads before it runs: none of it is MapLibre.
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = new Set<string>([entry.fileName]);
    for (const name of eager) for (const imported of byName.get(name)?.imports ?? []) eager.add(imported);
    const eagerMapLibre = [...eager].flatMap((name) => byName.get(name)?.moduleIds.filter((id) => MAPLIBRE.test(id)) ?? []);
    expect(eagerMapLibre).toEqual([]);

    // The chunk with MapLibre in it is one the entry imports when a map is drawn.
    const library = chunks.filter((chunk) => chunk.moduleIds.some((id) => MAPLIBRE.test(id)));
    expect(library.length).toBeGreaterThan(0);
    const lazy = library.find((chunk) => chunk.isDynamicEntry);
    expect(entry.dynamicImports).toContain(lazy?.fileName);

    // MapLibre's worker and its styles come with it, as files of their own.
    const assets = files.filter((file) => file.type === "asset").map((file) => file.fileName);
    expect(assets.some((name) => /maplibre-gl-worker.*\.js$/.test(name))).toBe(true);
  }, 120_000);
});
