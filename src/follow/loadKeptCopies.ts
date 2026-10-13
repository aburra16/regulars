/** The section that lists a person's kept copies, as its chunk gives it. */
type SectionCode = typeof import("./KeptCopies.tsx");

/** The section's code, once it has been fetched in this tab. */
let fetched: SectionCode | undefined;

/**
 * The section of the person's own page that lists the copies kept of who they follow, with the way
 * to put one back (./KeptCopies.tsx): a chunk of its own, which that page fetches once the person has
 * a copy to show, and not before. Most visits open no such page, so the first screen does not carry
 * it. Each call asks for it afresh, so that a fetch that failed (a flaky network, or a deploy that
 * replaced the chunk) is tried again rather than remembered.
 */
export async function loadKeptCopies(): Promise<SectionCode> {
  fetched = await import("./KeptCopies.tsx");
  return fetched;
}

/**
 * The section's code when it has been fetched already (`loadKeptCopies`), so that it can be drawn at
 * once on every visit after the first; undefined until then.
 */
export function fetchedKeptCopies(): SectionCode | undefined {
  return fetched;
}
