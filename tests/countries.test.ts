import { afterEach, describe, expect, it, vi } from "vitest";

import { countryName } from "../src/places/countries";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("countryName", () => {
  it("names a country in English by its code, whatever its case and spacing", () => {
    expect(countryName("CZ")).toBe("Czechia");
    expect(countryName("pt")).toBe("Portugal");
    expect(countryName(" US ")).toBe("United States");
    expect(countryName("SV")).toBe("El Salvador");
  });

  it("names nothing for what is not a code of two letters", () => {
    for (const code of ["", "C", "CZE", "1A", "   "]) expect(countryName(code)).toBeUndefined();
  });

  it("names nothing for a code no country has", () => {
    expect(countryName("QQ")).toBeUndefined();
  });
});
