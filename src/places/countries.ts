/** The browser's English names of countries, made the first time one is asked for; null where the browser has none. */
let names: Intl.DisplayNames | null | undefined;

/**
 * A country's name in English, as the browser writes it ("Czechia", "United States"), by its
 * two-letter code in any case. Undefined for what is not such a code, for a code no country has, and
 * in a browser that cannot name countries (`Intl.DisplayNames`, which every browser the app supports
 * has). It needs no file: it names the country of a place whether or not the towns have loaded.
 */
export function countryName(code: string): string | undefined {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return undefined;
  try {
    names ??= typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }) : null;
    return names?.of(upper) ?? undefined;
  } catch {
    return undefined;
  }
}
