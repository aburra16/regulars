import { cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Address } from "../src/ui/address";

// A postcode ("9000-082") must stay whole on its line, and its hyphen must be the plain "-": a
// special hyphen (U+2011) is in none of the fonts the app loads, so it would be drawn in a fallback face.
function draw(text: string): HTMLElement {
  const { container } = render(<p><Address text={text} /></p>);
  return container.firstElementChild as HTMLElement;
}

describe("Address", () => {
  it("keeps the hyphen of a postcode as written: a plain hyphen, never U+2011", () => {
    const line = draw("138 Rua dos Ferreiros Funchal 9000-082");
    expect(line.textContent).toBe("138 Rua dos Ferreiros Funchal 9000-082");
    expect(line.textContent).toContain("-");
    expect(line.textContent).not.toContain("‑");
  });

  it("puts a postcode in one element that does not wrap, and nothing else in it", () => {
    const line = draw("138 Rua dos Ferreiros Funchal 9000-082");
    const wrapped = line.querySelectorAll(".whitespace-nowrap");
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]).toHaveTextContent(/^9000-082$/);
    expect(line.textContent).toBe("138 Rua dos Ferreiros Funchal 9000-082");
  });

  it("wraps the whole run of digits when there are several hyphens", () => {
    const wrapped = draw("Lote 1-2-3, Funchal").querySelectorAll(".whitespace-nowrap");
    expect([...wrapped].map((each) => each.textContent)).toEqual(["1-2-3"]);
  });

  it("wraps each postcode of an address that has two", () => {
    const wrapped = draw("9000-082 Funchal, formerly 9050-026").querySelectorAll(".whitespace-nowrap");
    expect([...wrapped].map((each) => each.textContent)).toEqual(["9000-082", "9050-026"]);
  });

  it("is plain text when no hyphen sits between digits", () => {
    for (const text of ["12 Rua Nova Funchal", "Rua Dr. Fernão de Ornelas 56-A, Funchal", "Santa-Cruz 9100 - 024", ""]) {
      const line = draw(text);
      expect(line.childElementCount, text).toBe(0);
      expect(line.textContent).toBe(text);
      cleanup();
    }
  });

  it("does not wrap a hyphen between letters", () => {
    const line = draw("Rua Sá-Carneiro");
    expect(line.querySelector(".whitespace-nowrap")).toBeNull();
    expect(line.childElementCount).toBe(0);
    expect(line.textContent).toBe("Rua Sá-Carneiro");
  });

  it("wraps the postcode and not the letters-and-hyphen around it", () => {
    const wrapped = draw("Rua Sá-Carneiro 12, Funchal 9000-082").querySelectorAll(".whitespace-nowrap");
    expect([...wrapped].map((each) => each.textContent)).toEqual(["9000-082"]);
  });
});
