import { createHash } from "node:crypto";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { copy } from "../src/copy/en";
import { BuiltOnBrainstorm, TONES } from "../src/ui/BuiltOnBrainstorm";

/*
 * "Built on Brainstorm", the quiet line at the foot of every page: Brainstorm's mark,
 * then the words, the whole of it one link to Brainstorm's own site, opened in a new tab. The line is
 * Brainstorm's shared element (src/ui/built-on-brainstorm.js, copied as Brainstorm gives it), which
 * draws itself in a shadow root and takes its look from Brainstorm's site; the app gives it its
 * colours. Here, the line itself. Where each page has it is in tests/pageFoot.test.tsx.
 */

/** The line's name for a screen reader: its words, then that it opens a new tab, as every link that leaves the app says. */
const NAME = `Built on Brainstorm ${copy.common.newTab}`;

afterEach(cleanup);

/** The line as the app draws it, and the link inside it. */
function drawn(element: Parameters<typeof render>[0]) {
  const { container } = render(element);
  const host = container.querySelector("built-on-brainstorm")!;
  expect(host).not.toBeNull();
  const root = host.shadowRoot!;
  return { host, root, link: root.querySelector("a")! };
}

describe("the line", () => {
  it("is one link to Brainstorm's site, opened in a new tab, which is told nothing of where the person came from", () => {
    const { root, link } = drawn(<BuiltOnBrainstorm />);
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(link).toHaveAttribute("href", "https://brainstorm.world");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says 'Built on Brainstorm', and to a screen reader that it opens in a new tab", () => {
    const { link } = drawn(<BuiltOnBrainstorm />);
    expect(NAME).toBe("Built on Brainstorm (opens in a new tab)");
    expect(link).toHaveAccessibleName(NAME);
    expect(link.querySelector('[part="words"]')).toHaveTextContent(/^Built on Brainstorm$/);
  });

  it("draws Brainstorm's mark before the words, exactly as Brainstorm draws it, in the colour of the words, and hides it from a screen reader", () => {
    const { link } = drawn(<BuiltOnBrainstorm />);
    const mark = link.querySelector("svg")!;
    expect(link.firstElementChild).toBe(mark);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("viewBox", "0 0 71 73");
    // One colour, the words': its own two colours turn to mud at this size.
    expect(mark).toHaveAttribute("fill", "currentColor");
    expect(mark.querySelectorAll("*")).toHaveLength(1);
    // The path as Brainstorm gives it: 2,280 characters, none changed.
    const path = mark.querySelector("path")!.getAttribute("d")!;
    expect(path).toHaveLength(2280);
    expect(createHash("sha256").update(path).digest("hex")).toBe("1cb58d464345120ce16678221fff92cb0f3f3dea709145d6c350143f0695b9f4");
  });

  it("takes its look from Brainstorm's own site, which the page's policy lets in as a stylesheet (tests/csp.test.ts)", () => {
    const { root } = drawn(<BuiltOnBrainstorm />);
    expect(root.querySelector('link[rel="stylesheet"]')).toHaveAttribute("href", "https://brainstorm.world/built-on/v1.css");
  });

  it("is quiet: a caption in the muted colour, that turns to the ink when pointed at or focused", () => {
    expect(TONES.page).toBe("[--built-on-color:var(--muted)] [--built-on-hover-color:var(--ink)]");
    const { host } = drawn(<BuiltOnBrainstorm />);
    expect(host).toHaveClass("text-caption", ...TONES.page.split(" "));
  });

  it("on the sign-in page's dark ground, is in that page's caption colour, and turns to its white", () => {
    expect(TONES.night).toBe("[--built-on-color:var(--line-dashed)] [--built-on-hover-color:var(--ground)]");
    const { host } = drawn(<BuiltOnBrainstorm tone="night" />);
    expect(host).toHaveClass("text-caption", ...TONES.night.split(" "));
    expect(host).not.toHaveClass(...TONES.page.split(" "));
  });

  it("takes the room it is given where it sits", () => {
    const { host } = drawn(<BuiltOnBrainstorm className="mt-1.5 -mb-3 self-start" />);
    expect(host).toHaveClass("mt-1.5", "-mb-3", "self-start", "text-caption");
  });
});
