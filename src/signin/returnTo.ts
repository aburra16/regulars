import type { Path } from "react-router-dom";

/**
 * The page that sent the person to sign in, from the router state of the link that did
 * (`state={{ from: location }}`): where "Keep House picks" goes back to. Undefined when there is
 * none, or when what is there is not a page of this app: router state is kept with the history, so
 * it is checked like any input. A page is a path that starts with one slash, not two (which is
 * another site's address), and is not the sign-in page itself, which would be no way out of it.
 */
export function cameFrom(state: unknown): Path | undefined {
  if (typeof state !== "object" || state === null || !("from" in state)) return undefined;
  const { from } = state;
  if (typeof from !== "object" || from === null) return undefined;
  const { pathname, search, hash } = from as Record<string, unknown>;
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return undefined;
  if (pathname === "/signin") return undefined;
  return {
    pathname,
    search: typeof search === "string" ? search : "",
    hash: typeof hash === "string" ? hash : "",
  };
}
