/** A place's page, by the place's `d`: `/place/:d`. */
export const placePath = (d: string): string => `/place/${encodeURIComponent(d)}`;

/** The form that reviews a place, by the place's `d`: `/place/:d/review` (screen 8; on a desktop, D3 over the place's page). */
export const reviewPath = (d: string): string => `${placePath(d)}/review`;
