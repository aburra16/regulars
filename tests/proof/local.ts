/**
 * The hosts of a relay on this machine, as `URL` writes them: it lowercases a name, and writes
 * other forms of these addresses (`127.1`, `[0:0:0:0:0:0:0:1]`) the way they are written here.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Throws unless `url` is a relay (`ws:` or `wss:`) on this machine: localhost, 127.0.0.1 or [::1].
 * The proof publishes test events with throwaway keys, and they must reach no other relay, so it
 * calls this before it opens any connection, and again for any relay an event names.
 */
export function assertLocal(url: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL; refused below.
  }
  const isRelay = parsed?.protocol === "ws:" || parsed?.protocol === "wss:";
  if (parsed === undefined || !isRelay || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      "The proof publishes only on this machine: a ws: or wss: relay at localhost, 127.0.0.1 or [::1]. " +
        `Refusing ${JSON.stringify(url)}.`,
    );
  }
}
