# Regulars

Restaurant ratings from people you'd actually ask. Live at [askregulars.world](https://askregulars.world) (not yet deployed).

Regulars is a reference app for the Food and Drink Places list: 7,954 places published on nostr by the Mise en Place curator, built by [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place). Scores are worked out at read time from the reviewers a point of view trusts: the house's (Mise en Place) or, after opting in, your own.

## Where things are

- `handoff/`: the design handoff, unchanged. Start with `handoff/START_HERE.md`.
- `docs/decisions.md`: decisions made after the handoff. Where it differs from the handoff brief, it wins.
- `docs/plans/`: implementation plans.
- `src/`: the app. `tests/`: its tests. `tools/notices.ts`: the build step that writes the third-party notices.

## Develop

Node 22 (see `.nvmrc`).

```sh
npm ci
cp .env.example .env.local   # then set VITE_MAPTILER_KEY, the MapTiler key for the map
npm run dev
```

Open the app at <http://localhost:5173> (or the port Vite prints). Use `localhost`, not `127.0.0.1`: the MapTiler key only allows the origins it lists. Without a key the app still runs, on a plain ground with no map tiles.

The app reads the places from `wss://dcosl.brainstorm.world` and the map from `api.maptiler.com`, and from no other host.

## Test

```sh
npm test            # Vitest, once
npm run typecheck   # TypeScript, no output
npm run build       # what the deploy builds: the app in dist/, with dist/THIRD_PARTY_NOTICES.txt
```

Tests never open a network socket: they read places through an in-memory reader (`tests/support/memoryReader.ts`) and draw maps with a stand-in for MapLibre (`tests/support/fakeMaplibre.ts`).

## Deploy

Push to `main`. The Deploy workflow (`.github/workflows/deploy.yml`) runs the tests, builds the site, copies `index.html` to `404.html` so a link straight to a page loads, and publishes `dist/` to GitHub Pages, which serves it at `askregulars.world` (`public/CNAME`).

The MapTiler key comes from the repository secret `VITE_MAPTILER_KEY`. Without it the build still succeeds and the site has no map tiles.

Pull requests and other branches run the Test workflow (`.github/workflows/test.yml`): tests and a build.

## Operations notes

- **One request for the list.** The app reads the whole list in one request of up to 10,000 places (`DEFAULT_PAGE_SIZE` in `src/places/load.ts`), and assumes the relay's limit (its `max_limit`) allows that many. A relay with a lower limit sends a shorter answer, which the app takes for the whole list: a device that has a fuller copy keeps it, but a first visit shows only what came.
- **No more than 10,000 places at one `created_at`.** Paging goes back by time, and cannot get past a second that holds more places than one request returns. The importer must spread a larger run over more than one second.
- **The MapTiler key's allowed origins** must include `askregulars.world` and `localhost` (for development), or the map stays blank.

## Data and licence

Place data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright), gathered by [BTC Map](https://btcmap.org). Code: MIT, see `LICENSE`. The licences of the packages the site is built from are in `THIRD_PARTY_NOTICES.txt` at the root of the built site.
