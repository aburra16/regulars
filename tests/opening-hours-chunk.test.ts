// @vitest-environment node
import { resolve } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

// `opening_hours` is LGPL-3.0, and decisions.md #13 promises it ships unmodified as its own
// chunk. This builds the real vite.config.ts (in memory, nothing is written) from an entry that
// imports the hours module, and checks the library lands in a file of its own.
const ROOT = process.cwd();
const ENTRY = resolve(ROOT, "tests/support/hours-entry.ts");
// Text only the library has (it names itself in its error messages), which the minifier keeps.
// The app's own code calls getNextChange, so a method name would also be found there.
const LIBRARY_MARKER = "opening_hours.js";

type Output = Awaited<ReturnType<typeof build>>;
interface Chunk {
  fileName: string;
  code: string;
  imports: string[];
  isEntry: boolean;
}

function chunksOf(result: Output): Chunk[] {
  const results = Array.isArray(result) ? result : [result];
  return results
    .flatMap((r) => ("output" in r ? r.output : []))
    .filter((file) => file.type === "chunk")
    .map(({ fileName, code, imports, isEntry }) => ({ fileName, code, imports, isEntry }));
}

describe("the opening_hours chunk", () => {
  it("is built as a separate file, imported by the app, with none of its code anywhere else", async () => {
    const chunks = chunksOf(
      await build({
        root: ROOT,
        configFile: resolve(ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false, copyPublicDir: false, rolldownOptions: { input: ENTRY } },
      }),
    );

    const library = chunks.filter((chunk) => chunk.fileName.includes("opening-hours"));
    expect(library.map((chunk) => chunk.fileName)).toHaveLength(1);
    expect(library[0]?.code).toContain(LIBRARY_MARKER);

    const rest = chunks.filter((chunk) => !chunk.fileName.includes("opening-hours"));
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.filter((chunk) => chunk.code.includes(LIBRARY_MARKER))).toEqual([]);

    // The app's own code is in an entry chunk that loads the library chunk.
    const entry = rest.find((chunk) => chunk.isEntry);
    expect(entry?.code).toContain("Open until");
    expect(entry?.imports).toContain(library[0]?.fileName);
  }, 60_000);
});
