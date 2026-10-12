import { createHash } from "node:crypto";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { BRAINSTORM_MARK, BuiltOnBrainstorm } from "../src/ui/BuiltOnBrainstorm";

/*
 * "Built on Brainstorm", the quiet line at the foot of every page: Brainstorm's mark,
 * then the words, the whole of it one link to Brainstorm's own site, opened in a new tab. Here, the
 * line itself. Where each page has it is in tests/pageFoot.test.tsx.
 */

/** The line's name for a screen reader: its words, then that it opens a new tab, as every link that leaves the app says. */
const NAME = `${copy.common.builtOn} ${copy.common.newTab}`;

afterEach(cleanup);

describe("the line", () => {
  it("is one link to Brainstorm's site, opened in a new tab, which is told nothing of where the person came from", () => {
    render(<BuiltOnBrainstorm />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(config.brainstormSite).toBe("https://brainstorm.world");
    expect(link).toHaveAttribute("href", "https://brainstorm.world");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says 'Built on Brainstorm', and to a screen reader that it opens in a new tab", () => {
    render(<BuiltOnBrainstorm />);
    expect(copy.common.builtOn).toBe("Built on Brainstorm");
    expect(NAME).toBe("Built on Brainstorm (opens in a new tab)");
    const link = screen.getByRole("link", { name: NAME });
    // On screen, the words alone: the rest is for a screen reader.
    const seen = [...link.childNodes].filter((node) => !(node instanceof Element && node.classList.contains("sr-only")));
    expect(seen.map((node) => node.textContent).join("").trim()).toBe("Built on Brainstorm");
    expect(link.querySelector(".sr-only")).toHaveTextContent(copy.common.newTab);
  });

  it("draws Brainstorm's mark before the words, exactly as Brainstorm draws it, in the colour of the words, and hides it from a screen reader", () => {
    render(<BuiltOnBrainstorm />);
    const link = screen.getByRole("link", { name: NAME });
    const mark = link.querySelector("svg")!;
    expect(link.firstElementChild).toBe(mark);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("viewBox", "0 0 71 73");
    // One colour, the words': its own two colours turn to mud at this size.
    expect(mark).toHaveAttribute("fill", "currentColor");
    expect(mark.querySelectorAll("*")).toHaveLength(1);
    const path = mark.querySelector("path")!;
    expect(path.getAttribute("d")).toBe(BRAINSTORM_MARK);
    expect(path).not.toHaveAttribute("fill");
    // The path as Brainstorm gives it: 2,280 characters, none changed.
    expect(BRAINSTORM_MARK).toHaveLength(2280);
    expect(BRAINSTORM_MARK).toMatch(/^M1\.10814 72\.5347C[\d .CLMZ-]+L1\.10814 72\.5347Z$/);
    expect(createHash("sha256").update(BRAINSTORM_MARK).digest("hex")).toBe("1cb58d464345120ce16678221fff92cb0f3f3dea709145d6c350143f0695b9f4");
  });

  it("draws the mark about 14 px tall, as wide as its own shape makes it", () => {
    render(<BuiltOnBrainstorm />);
    const mark = screen.getByRole("link", { name: NAME }).querySelector("svg")!;
    expect(Number(mark.getAttribute("height"))).toBe(14);
    expect(Number(mark.getAttribute("width"))).toBeCloseTo((14 * 71) / 73, 2);
    // It keeps its size beside the words.
    expect(mark).toHaveClass("shrink-0");
  });

  it("is quiet: a caption in the muted colour, with room to tap, that turns to the ink and is underlined when pointed at or focused", () => {
    render(<BuiltOnBrainstorm />);
    const link = screen.getByRole("link", { name: NAME });
    expect(link).toHaveClass("text-caption", "text-muted", "no-underline", "min-h-touch");
    expect(link).toHaveClass("hover:text-ink", "hover:underline", "focus-visible:text-ink", "focus-visible:underline");
  });

  it("holds its words for a screen reader to itself, so that in a list that scrolls in its own column they do not make the window taller", () => {
    // jsdom lays nothing out: in a browser, words drawn out of the flow are placed by the nearest thing
    // around them that is positioned, which without this is the page, well below the foot of the window.
    render(<BuiltOnBrainstorm />);
    const link = screen.getByRole("link", { name: NAME });
    expect(link).toHaveClass("relative");
    expect(link.querySelector(".sr-only")!.parentElement).toBe(link);
  });

  it("on the sign-in page's dark ground, is in that page's caption colour, and turns to its white", () => {
    render(<BuiltOnBrainstorm tone="night" />);
    const link = screen.getByRole("link", { name: NAME });
    expect(link).toHaveClass("text-caption", "text-line-dashed", "no-underline", "min-h-touch");
    expect(link).toHaveClass("hover:text-ground", "hover:underline", "focus-visible:text-ground", "focus-visible:underline");
    expect(link).not.toHaveClass("text-muted");
  });
});
