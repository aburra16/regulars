/**
 * Where the About page's sections are, for the pages that link to them: `/about#how-scores-work`
 * from Explore's "How this works", `/about#signing-in` from the sign-in page. The page and its
 * links take the names from here, so a link cannot name a section the page does not have.
 */
export const HOW_SCORES_WORK = "how-scores-work";
export const SIGNING_IN = "signing-in";

/** The address of a section of the About page. */
export const aboutAt = (anchor: typeof HOW_SCORES_WORK | typeof SIGNING_IN): string => `/about#${anchor}`;
