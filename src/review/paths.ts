/** A place's page, by the place's `d`: `/place/:d`. */
export const placePath = (d: string): string => `/place/${encodeURIComponent(d)}`;

/** The form that reviews a place, by the place's `d`: `/place/:d/review` (screen 8; on a desktop, D3 over the place's page). */
export const reviewPath = (d: string): string => `${placePath(d)}/review`;

/** A place's page, as the address has it: `/place/:d`, with nothing under it. */
const PLACE_PAGE = /^\/place\/[^/]+$/;

/**
 * Whether `path` is the address of the form that reviews the place whose page is at `place`, both as
 * the address has them: `/place/:d/review` over `/place/:d`. No other two paths are such a pair.
 */
export const isFormOver = (place: string, path: string): boolean => PLACE_PAGE.test(place) && path === `${place}/review`;
