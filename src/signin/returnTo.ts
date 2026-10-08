import type { Path } from "react-router-dom";

/**
 * `value` as a page of this app (`{ pathname, search, hash }`), or undefined when it is not one:
 * router state is kept with the history, so it is checked like any input. A page is a path that
 * starts with one slash, not two (which is another site's address), and is not the sign-in page
 * itself, which would be no way out of it.
 */
function pageIn(value: unknown): Path | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { pathname, search, hash } = value as Record<string, unknown>;
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return undefined;
  if (pathname === "/signin") return undefined;
  return {
    pathname,
    search: typeof search === "string" ? search : "",
    hash: typeof hash === "string" ? hash : "",
  };
}

/** The field `name` of router state, if the state is an object that has it. */
function fieldOf(state: unknown, name: string): unknown {
  return typeof state === "object" && state !== null && name in state ? (state as Record<string, unknown>)[name] : undefined;
}

/**
 * The page that sent the person to sign in, from the router state of the link that did
 * (`state={{ from: location }}`): where "Keep House picks" goes back to. Undefined when there is
 * none, or when what is there is not a page of this app (see `pageIn`).
 */
export function cameFrom(state: unknown): Path | undefined {
  return pageIn(fieldOf(state, "from"));
}

/**
 * The page the person was on their way to when a link sent them to sign in first
 * (`state={{ from: location, next: page }}`): "Rate this place" sends a person who is signed out to
 * sign in, and then to the review form. Once they have signed in, it opens in place of the sign-in
 * page; if they leave without signing in, they go back to where they came from. Undefined when there
 * is none, or it is not a page of this app (see `pageIn`).
 */
export function goingTo(state: unknown): Path | undefined {
  return pageIn(fieldOf(state, "next"));
}
