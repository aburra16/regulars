import kinds from "../data/kinds.json";

const FAMILY_IDS = [
  "restaurants",
  "cafes",
  "fast-food",
  "bars",
  "bakeries",
  "ice-cream",
  "farm-shops",
  "food-shops",
  "drink-shops",
  "breweries",
] as const;

export type FamilyId = (typeof FAMILY_IDS)[number];

export interface KindInfo {
  family: FamilyId;
  familyLabel: string;
  label: string;
  /** URL of the kind's svg icon. */
  icon: string;
}

export interface Family {
  id: FamilyId;
  label: string;
  /** URL of the family's svg icon. */
  icon: string;
}

/** Where a category that kinds.json does not list belongs. */
const FALLBACK_FAMILY: FamilyId = "food-shops";

/** Every svg in src/assets/icons as a URL, keyed by path. */
const iconUrls = import.meta.glob<string>("../assets/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

function iconUrl(file: string): string {
  const url = iconUrls[`../assets/icons/${file}`];
  if (url === undefined) throw new Error(`kinds.json names the icon ${file}, which is not in src/assets/icons`);
  return url;
}

function isFamilyId(id: string): id is FamilyId {
  return (FAMILY_IDS as readonly string[]).includes(id);
}

/** Text from the data as a label: `_` becomes a space and the first letter is upper case. */
function sentenceCase(text: string): string {
  const spaced = text.replace(/[_\s]+/g, " ").trim();
  const first = spaced.codePointAt(0);
  if (first === undefined) return "";
  const head = String.fromCodePoint(first);
  return head.toUpperCase() + spaced.slice(head.length);
}

export const FAMILIES: Family[] = kinds.families.map((family) => {
  if (!isFamilyId(family.id)) throw new Error(`kinds.json has an unknown family: ${family.id}`);
  return { id: family.id, label: family.label, icon: iconUrl(family.icon) };
});

const familyById = new Map(FAMILIES.map((family) => [family.id, family]));

// A Map, not an object: a category called "constructor" must not find a property.
const kindByCategory = new Map<string, KindInfo>(
  kinds.families.flatMap((raw) => {
    const family = familyById.get(raw.id as FamilyId);
    if (family === undefined) throw new Error(`kinds.json has an unknown family: ${raw.id}`);
    return raw.values.map(
      (value): [string, KindInfo] => [
        value.osm,
        { family: family.id, familyLabel: family.label, label: value.label, icon: family.icon },
      ],
    );
  }),
);

/** The family, label and icon for a place's category. An unknown category reads as itself, in the food-shop family. */
export function kindOf(category: string): KindInfo {
  const known = kindByCategory.get(category);
  if (known !== undefined) return known;
  const family = familyById.get(FALLBACK_FAMILY);
  if (family === undefined) throw new Error(`kinds.json has no ${FALLBACK_FAMILY} family`);
  return { family: family.id, familyLabel: family.label, label: sentenceCase(category), icon: family.icon };
}

/** "coffee_shop" reads "Coffee shop"; "bubble_tea" reads "Bubble tea". */
export function cuisineLabel(cuisine: string): string {
  return sentenceCase(cuisine);
}

/** Every kind that kinds.json lists, with the family it belongs to. */
export const KINDS: readonly { category: string; label: string; family: FamilyId }[] = [...kindByCategory].map(
  ([category, info]) => ({ category, label: info.label, family: info.family }),
);

/**
 * Words people use for a kind of place that its label does not say. Search reads them as part
 * of a place, like its keywords, and ranks by relevance; they are shown nowhere and they do not
 * make a query a list of the family (see `KIND_SYNONYMS`). They are by family; the bars family
 * holds pubs too, so it has the word for both.
 */
export const FAMILY_SEARCH_TERMS: Partial<Record<FamilyId, string>> = {
  cafes: "coffee café",
  bars: "drinks beer",
  bakeries: "bread pastry",
  "ice-cream": "gelato",
  "fast-food": "takeaway burger",
  breweries: "beer wine",
};

/**
 * Words that mean a whole family when they are the query: "coffee" lists the cafes. These are
 * the only synonyms that count. Any other word, like "burger" or "wine", makes a kind query only
 * when it is a kind label, or a cuisine that at least `KIND_CUISINE_MIN` places have (see
 * indexes.ts). Otherwise it is searched for by relevance, like any other word.
 */
export const KIND_SYNONYMS: Readonly<Record<string, FamilyId>> = {
  coffee: "cafes",
  café: "cafes",
  cafe: "cafes",
  gelato: "ice-cream",
  takeaway: "fast-food",
  bread: "bakeries",
  drinks: "bars",
};

/** These kinds take the cuisine in front: "Mexican restaurant". Every other kind takes it after a dot. */
const CUISINE_FIRST = new Set(["restaurant", "cafe", "bar", "pub"]);

/** What a place is, in words: "Mexican restaurant", "Fast food · Burger", "Bakery". */
export function placeKindLabel(category: string, cuisine?: string): string {
  const kind = kindOf(category).label;
  if (cuisine === undefined || cuisine.trim() === "") return kind;

  const cuisineText = cuisineLabel(cuisine);
  // "Ice cream" that is ice cream, "Bakery" that is a bakery: say it once.
  if (cuisineText.toLowerCase() === kind.toLowerCase()) return kind;

  if (CUISINE_FIRST.has(category)) {
    // A coffee shop is the cafe's own kind of place, not a cuisine to put in front of "cafe".
    if (category === "cafe" && cuisine.trim().toLowerCase() === "coffee_shop") return cuisineText;
    return `${cuisineText} ${kind.toLowerCase()}`;
  }
  return `${kind} · ${cuisineText}`;
}
