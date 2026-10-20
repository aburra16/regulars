/*
 * Writes the pages a shared link opens into the built site, dist/: one for each place on the list,
 * each chain and each fixed page, each the built index.html with its own title and preview, and
 * dist/sitemap.xml and dist/robots.txt (src/share/run.ts).
 *
 *   npm run build && npm run share-pages
 *
 * The website's deploy runs it after the build and before the copy of index.html to 404.html
 * (.github/workflows/deploy.yml). It reads the list from the hub (`config.placesRelay`), and only
 * reads: without an answer, or with fewer places than the floor (`SHARE_FLOOR` in
 * src/share/fetchPlaces.ts), it writes nothing and exits with an error, which stops the deploy.
 *
 * The app's modules read `import.meta.env` and import JSON, which Node does not run by itself, so
 * Vite loads them, in production mode, as it builds them. Node 22.18 or later runs this file as it is.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({ root, mode: "production", server: { middlewareMode: true }, appType: "custom" });
try {
  const { shareStep } = (await server.ssrLoadModule("/src/share/run.ts")) as typeof import("../src/share/run.ts");
  console.log(await shareStep(join(root, "dist")));
} catch (error) {
  console.error("The shared pages were not written:", error);
  process.exitCode = 1;
} finally {
  await server.close();
}
