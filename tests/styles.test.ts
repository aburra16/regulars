import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("styles", () => {
  const indexCss = read("src/styles/index.css");

  it("carries handoff/design/tokens.css verbatim", () => {
    expect(indexCss).toContain(read("handoff/design/tokens.css").trim());
  });

  it("puts Noto Sans JP before the generic fallbacks so Japanese place names use it", () => {
    expect(indexCss).toMatch(/--font-display:\s*'Bricolage Grotesque', 'Noto Sans', 'Noto Sans JP', sans-serif;/);
    expect(indexCss).toMatch(/--font-text:\s*'Figtree', 'Noto Sans', 'Noto Sans JP', system-ui, sans-serif;/);
  });

  it("sets the body font, colour and background from the tokens", () => {
    expect(indexCss).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-text\)/);
    expect(indexCss).toMatch(/body\s*\{[^}]*color:\s*var\(--ink\)/);
    expect(indexCss).toMatch(/body\s*\{[^}]*background:\s*var\(--ground\)/);
  });
});
