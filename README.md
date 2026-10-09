# Regulars

Places to eat and drink, rated by people you'd actually ask. Live at [askregulars.world](https://askregulars.world) (not yet deployed).

Regulars is a reference app for the Food and Drink Places list: 7,954 places published on nostr by the Mise en Place curator, built by [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place). Scores are worked out at read time from the reviewers a point of view trusts: the house's (Mise en Place) or, after opting in, your own.

## Where things are

- `handoff/`: the design handoff, unchanged. Start with `handoff/START_HERE.md`.
- `docs/decisions.md`: decisions made after the handoff. Where it differs from the handoff brief, it wins.
- `docs/plans/`: implementation plans.
- `docs/m1-handover.md`: where M1 stands, what needs Avi, and the rulings made while building it.
- `src/`: the app. `tests/`: its tests. `tools/notices.ts`: the build step that writes the third-party notices. `tools/towns.ts`: writes `src/data/towns.json`, the towns the places are put in (see "Operations notes").

## Develop

Node 22 (see `.nvmrc`).

```sh
npm ci
cp .env.example .env.local   # then set VITE_MAPTILER_KEY, the MapTiler key for the map
npm run dev
```

Open the app at <http://localhost:5173> (or the port Vite prints). Use `localhost`, not `127.0.0.1`: the MapTiler key only allows the origins it lists. Without a key the app still runs, on a plain ground with no map tiles.

The app reads the places from `wss://dcosl.brainstorm.world` and the map from `api.maptiler.com`. In production it also reads the reviews of the places on screen, and their reviewers' names, from `wss://search.brainstorm.world`, `wss://nos.lol` and `wss://relay.primal.net` (a review is posted to all three, and counts once any of them takes it); the house's choice of scorer from `wss://scores.brainstorm.world`; and the ranks from the relay that choice names. In development it reads no reviews unless `VITE_REVIEW_RELAYS` is set (see "House scores, locally"), so every place says "No reviews yet".

A person who signs in brings three more, each only while they are needed:

- `wss://purplepag.es`, read when posting or removing a review, for the person's relay list (kind 10002), beside the review relays (`config.relayListRelays`);
- the person's own write relays, which that list names, sent the review when posting, and the removal when removing one;
- `wss://relay.nsec.app` (`config.connectRelay`), or the relay a bunker link names, to sign in with an app on a phone, and to ask that app to sign.

## Test

```sh
npm test            # Vitest, once
npm run typecheck   # TypeScript, no output
npm run build       # what the deploy builds: the app in dist/, with dist/THIRD_PARTY_NOTICES.txt
```

Tests never open a network socket: they read places through an in-memory reader (`tests/support/memoryReader.ts`) and draw maps with a stand-in for MapLibre (`tests/support/fakeMaplibre.ts`).

## House scores, locally

A proof of house scores on a relay on this machine. It makes throwaway keys in memory for a house, its scorer and four reviewers, and publishes the house's choice of scorer (kind 10040), the scorer's ranks (kind 30382) and reviews of two places (kind 34259). Then it reads them back through the app's reader and scores the places with the app's code. It is not part of `npm test`, and it refuses any relay that is not at localhost, 127.0.0.1 or [::1].

It needs [nak](https://github.com/fiatjaf/nak) (0.19.3 or later). In one terminal, start an in-memory relay at `ws://localhost:10547`:

```sh
nak serve --events tests/fixtures/forged-reviews.jsonl
```

In another, run the proof:

```sh
npm run proof:house-scores
```

The relay loads two forged reviews when it starts: it checks the signature of each event published to it, but not of the events it loads. The proof checks that the app's reader drops them.

- `PROOF_RELAY=<url>` uses another relay on this machine.
- `PROOF_KEEP=1` also prints the `.env.local` lines (`VITE_REVIEW_RELAYS`, `VITE_DEV_SCORER`) that point the dev app at the relay and the run's scorer. The relay keeps the events until it stops. With them set, `npm run dev` shows Jacafé at 4.5 from 2 people, with 2 reviews folded, and Loft Brunch & Cocktails with no score and 1 folded.

## Deploy

Push to `main`. The Deploy workflow (`.github/workflows/deploy.yml`) runs the tests, builds the site, copies `index.html` to `404.html` so a link straight to a page loads, and publishes `dist/` to GitHub Pages, which serves it at `askregulars.world` (`public/CNAME`).

The MapTiler key comes from the repository secret `VITE_MAPTILER_KEY`. Without it the build still succeeds and the site has no map tiles.

Pull requests and other branches run the Test workflow (`.github/workflows/test.yml`): tests and a build.

## Operations notes

- **One request for the list.** The app reads the whole list in one request of up to 10,000 places (`DEFAULT_PAGE_SIZE` in `src/places/load.ts`), and assumes the relay's limit (its `max_limit`) allows that many. A relay with a lower limit sends a shorter answer, which the app takes for the whole list: a device that has a fuller copy keeps it, but a first visit shows only what came.
- **No more than 10,000 places at one `created_at`.** Paging goes back by time, and cannot get past a second that holds more places than one request returns. The importer must spread a larger run over more than one second.
- **Towns, at each monthly refresh of the places.** `src/data/towns.json` holds the towns the places are put in, cut down from GeoNames' list (cities1000, CC BY 4.0) to the ones the places need, so it goes stale as places are added. After each import, make it again from the live list, the places the app loads:
  1. Read the live list from the places relay, one event to a line, with [nak](https://github.com/fiatjaf/nak): `nak req -k 39999 -a <house key> -t z=<list coordinate> -l 10000 wss://dcosl.brainstorm.world > places-live.jsonl`. The key and the coordinate are `config.houseHex` and `config.headerCoordinate` in `src/config.ts`. Fewer than 10,000 lines is the whole list (see "One request for the list" above).
  2. Download `cities1000.zip` from <https://download.geonames.org/export/dump/> and unzip it.
  3. Run `node tools/towns.ts cities1000.txt places-live.jsonl --date <download day>` and commit the file. It prints how many towns and parts it kept, and the localities it keeps as towns of their own (El Zonte).

  The tool reads only those files; it asks no relay or server anything. Capitals whose districts GeoNames lists as towns, where the places carry no locality, take their districts in through a reviewed list, `tools/towns-absorb.ts` (Bangkok). Until the file is made again, a new place goes in the town its locality names, or the file's nearest town within 30 km, or, with none that near, in the town its locality names. The site never asks GeoNames anything; the countries' names come from the browser.
- **The Content Security Policy** is a meta tag the build writes into `index.html` (`tools/csp.ts`), with the hash of the theme's script, since GitHub Pages sets no headers. It lets the page reach its own files, MapTiler, Brainstorm's API and any `wss:` relay, and show pictures from any https site. Code that reaches a new site needs it added there; `tests/csp.test.ts` fails on an address in the code that the policy refuses. A meta tag cannot set `frame-ancestors`, so nothing keeps the site out of other sites' frames.
- **The MapTiler key's allowed origins** must include `askregulars.world` and `localhost` (for development), or the map stays blank.
- **Reviews are read in batches of 50 places, two batches at a time.** A page asks for all its places at once (`src/score/store.ts`). Each batch is two requests to every review relay, side by side: one by the places' `a` tag and one by their `d`, so reviews written by other apps with a `d` alone are found too (decision 16). A relay therefore has at most four of the app's review requests open at once (`BATCHES_IN_FLIGHT`); the other batches wait their turn. Each request asks for at most 500 reviews. One that comes back full is followed by the next page, back in time (`until` = the oldest review seen), so a place with hundreds of reviews (spam, say) can't push the other places' reviews in its batch out of the answer. A full page that gets no further back (more than 500 reviews in one second) is followed by one from the second before: the rest of that second is not read, and the older reviews are. A request reads at most 5 pages (`REVIEW_PAGES`, 2,500 reviews); past that, the batch is cut short. Names are read 100 people to a request, two requests at a time, and the house's ranks 500 people to a request, two requests at a time.
- **The house's view recovers.** House picks are unavailable only when the house's choice of scorer (kind 10040) can't be read, or its scorer's relay fails before it has given any rank. A rank read that fails later lets go of only that read's reviewers, who are asked about again at the next try; the places already ranked keep their scores. Explore and the place page offer Try again beside "House picks aren't available right now.", and the app tries again by itself when the browser says it is back on line, at most once in 5 seconds (`ONLINE_CALM_MS`), so a connection that comes and goes doesn't keep stopping reads that are doing well.

## Data and licence

Place data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright), gathered by [BTC Map](https://btcmap.org). Town names from [GeoNames](https://www.geonames.org), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`src/data/towns.json`). Code: MIT, see `LICENSE`. The licences of the packages the site is built from are in `THIRD_PARTY_NOTICES.txt` at the root of the built site.
