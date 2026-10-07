import { describe, expect, it } from "vitest";

import kinds from "../src/data/kinds.json";
import { cuisineLabel, FAMILIES, kindOf, placeKindLabel } from "../src/places/kinds";

describe("kindOf", () => {
  it("labels a known category from kinds.json", () => {
    expect(kindOf("fast_food").label).toBe("Fast food");
    expect(kindOf("fast_food").family).toBe("fast-food");
  });

  it("names the family a category belongs to", () => {
    expect(kindOf("biergarten").familyLabel).toBe("Bars and pubs");
    expect(kindOf("biergarten").family).toBe("bars");
  });

  it("resolves every category in kinds.json to its own family and label", () => {
    for (const family of kinds.families) {
      for (const value of family.values) {
        const info = kindOf(value.osm);
        expect(info.family).toBe(family.id);
        expect(info.familyLabel).toBe(family.label);
        expect(info.label).toBe(value.label);
      }
    }
  });

  it("falls back to the food-shop family and a readable label for an unknown category", () => {
    const info = kindOf("zz_new");
    expect(info.label).toBe("Zz new");
    expect(info.family).toBe("food-shops");
    expect(info.familyLabel).toBe("Food shops");
    expect(info.icon).toBe(kindOf("butcher").icon);
  });

  it("does not mistake an object property name for a category", () => {
    expect(kindOf("constructor").family).toBe("food-shops");
    expect(kindOf("constructor").label).toBe("Constructor");
    expect(kindOf("toString").label).toBe("ToString");
  });

  it("gives each family its own icon url", () => {
    expect(kindOf("restaurant").icon).toBe(FAMILIES[0]?.icon);
    const icons = FAMILIES.map((family) => family.icon);
    expect(icons.every((icon) => typeof icon === "string" && icon.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(10);
  });
});

describe("cuisineLabel", () => {
  it.each([
    ["coffee_shop", "Coffee shop"],
    ["bubble_tea", "Bubble tea"],
    ["mexican", "Mexican"],
    ["ice_cream", "Ice cream"],
    ["  regional ", "Regional"],
  ])("%j reads %j", (cuisine, label) => {
    expect(cuisineLabel(cuisine)).toBe(label);
  });
});

describe("placeKindLabel", () => {
  it.each<[string, string | undefined, string]>([
    ["restaurant", "mexican", "Mexican restaurant"],
    ["restaurant", undefined, "Restaurant"],
    ["cafe", "coffee_shop", "Coffee shop"],
    ["cafe", "bubble_tea", "Bubble tea cafe"],
    ["bar", undefined, "Bar"],
    ["pub", "regional", "Regional pub"],
    ["fast_food", "burger", "Fast food · Burger"],
    ["bakery", undefined, "Bakery"],
    ["ice_cream", "ice_cream", "Ice cream"],
  ])("%s with cuisine %s reads %j", (category, cuisine, label) => {
    expect(placeKindLabel(category, cuisine)).toBe(label);
  });

  it("gives the kind alone when the cuisine is blank", () => {
    expect(placeKindLabel("pub", "")).toBe("Pub");
    expect(placeKindLabel("fast_food", "  ")).toBe("Fast food");
  });

  it("gives the kind alone when the cuisine repeats it, whatever the kind", () => {
    expect(placeKindLabel("restaurant", "restaurant")).toBe("Restaurant");
    expect(placeKindLabel("bakery", "Bakery")).toBe("Bakery");
  });

  it("joins the kind and cuisine with a dot for kinds outside restaurant, cafe, bar and pub", () => {
    expect(placeKindLabel("biergarten", "german")).toBe("Beer garden · German");
    expect(placeKindLabel("zz_new", "thai")).toBe("Zz new · Thai");
  });
});

describe("FAMILIES", () => {
  it("lists the ten families in kinds.json order", () => {
    expect(FAMILIES).toHaveLength(10);
    expect(FAMILIES.map((family) => family.id)).toEqual(kinds.families.map((family) => family.id));
    expect(FAMILIES.map((family) => family.label)).toEqual(kinds.families.map((family) => family.label));
  });
});
