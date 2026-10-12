/** A person's page, as its chunk gives it. */
type PageCode = typeof import("./PersonPage.tsx");

/** The page's code, once it has been fetched in this tab. */
let fetched: PageCode | undefined;

/**
 * A person's page (./PersonPage.tsx), with the reading of their reviews and of who follows them: a
 * chunk of its own, which the page's route fetches when a person's page is first opened
 * (./PersonRoute.tsx). Each call asks for it afresh, so that a fetch that failed (a flaky network, or a
 * deploy that replaced the chunk) is tried again rather than remembered.
 */
export async function loadPersonPage(): Promise<PageCode> {
  fetched = await import("./PersonPage.tsx");
  return fetched;
}

/**
 * The page's code when it has been fetched already (`loadPersonPage`), so that the page can be drawn
 * at once, with its heading, on every visit after the first; undefined until then.
 */
export function fetchedPersonPage(): PageCode | undefined {
  return fetched;
}
