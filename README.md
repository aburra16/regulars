# Regulars

Regulars is a web app for finding places to eat and drink, rated by people you'd actually ask. A place has no single rating: before you sign in, its rating comes from the reviewers the house curator, Mise en Place, trusts (House picks), and once you sign in and opt in, from the people you trust and the people they trust (My circle). It is live at [askregulars.world](https://askregulars.world).

Regulars is built on [Brainstorm](https://brainstorm.world)'s web of trust and [BTC Map](https://btcmap.org)'s places. Brainstorm works out how much each reviewer counts from a point of view, the house's or your own, and Regulars works out every score from those ranks at read time. The places are the Food and Drink Places list: 7,954 places from OpenStreetMap, gathered by BTC Map and published on nostr by the Mise en Place curator, built by [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place).

## Where things are

- `src/`: the app. Every string a person reads is in `src/copy/en.ts`, and the addresses the app reaches and what is switched on are in `src/config.ts`.
- `tests/`: its tests. `tests/support/` holds the in-memory relays and the stand-in for the map, and `tests/fixtures/` the data they use.
- `tools/`: the build's own steps, and the scripts that make the data and the icons. `tools/notices.ts` writes the third-party notices and `tools/csp.ts` the Content Security Policy, both at build time. `tools/towns.ts` writes `src/data/towns.json`, the towns the places are put in (see "Operations notes"). `tools/share-pages.ts` writes the pages a shared link opens (see "Deploy").

## Develop

Node 22 (see `.nvmrc`).

```sh
npm ci
npm run dev
```

Open the app at <http://localhost:5173> (or the port Vite prints). `.env.example` lists the optional development settings; copy it to `.env.local` to set them.

The app reads the places from `wss://dcosl.brainstorm.world` and the map from `tiles.openfreemap.org`, OpenFreeMap's public servers, which need no key: its styles, tiles, fonts and icons all come from there. When the map's style does not come, the map is a plain ground with the pins on it. In production it also reads the reviews of the places on screen, and their reviewers' names, from `wss://search.brainstorm.world`, `wss://nos.lol` and `wss://relay.primal.net` (a review is posted to all three, and counts once any of them takes it); the house's choice of scorer from `wss://scores.brainstorm.world`; and the ranks from the relay that choice names. In development it reads no reviews unless `VITE_REVIEW_RELAYS` is set (see "House scores, locally"), so every place says "No reviews yet".

A person who signs in brings three more, each only while they are needed:

- `wss://purplepag.es`, read when posting or removing a review, and (with Follow on) whenever the person's own follow list is read, for the person's relay list (kind 10002), beside the review relays (`config.relayListRelays`). A follow list is acted on only when this relay answered, or a relay list was found elsewhere: without that, no Follow button shows and a tap says it couldn't load, in development too;
- the person's own write relays, which that list names, sent the review when posting, and the removal when removing one;
- `wss://relay.nsec.app` (`config.connectRelay`), or the relay a bunker link names, to sign in with an app on a phone, and to ask that app to sign.

A follow list is read from, and a changed one saved to, the person's own relays and `config.followListRelays`: six public relays in production, and in development only the relays in `VITE_FOLLOW_LIST_RELAYS` (none when it is unset: then who the person follows can't be known unless their own relays have their list, and no Follow button shows). So none of the app's own follow-list relays is a public one in development; point it at a relay on this machine. That does not keep a development build off the public relays: signed in with a real key, it reads that key's relay list from `wss://purplepag.es` and saves a tapped follow to that person's own public relays, so sign in with a throwaway key in development.

Before a changed follow list is signed, the list it was built on is kept in the browser as the relays sent it (IndexedDB, under `regulars.follow.kept.<the person's key>`: the newest ten for each person, which stay through sign-out), and the You page lists those copies to that person signed in, each with a way to put it back in place of their list as it is now.

When the person's relay list names relays to write to and none of them answers, their follow list has not been read from where it is kept, and nothing is changed on the app's own say. If at least three of `config.followListRelays` hold the very same list, and it is dated neither before 2020 nor more than a day after the device's clock, the buttons draw from it, and a press changes nothing and asks first, with the day that list was last changed: several relays holding a list shows only that it was once sent widely, never that it is the newest. Only the person's answer makes the change, on that very list (by its id), and only once it is kept in the browser. After one such answer, once the list that change saved has been read back as the newest, later changes in the same visit go on without a second asking for as long as the newest list found is the very list Regulars itself saved; any other newest, and the person is asked again. That lasts until sign-out. With fewer than three, or a date outside those, no Follow button shows, as before. Every list of the person's that a read finds, whether or not the read can be trusted, is one the tab has seen: nothing is asked about, or built on, a list older than that.

Follow is on for everyone (`features.follow` in `src/config.ts`). It is also the off switch: set it to `false` and deploy, and the app has no Follow button and no line of who follows a person, reads and changes nobody's follow list, and does not ask a phone app to sign one.

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

Push to `main`. The Deploy workflow (`.github/workflows/deploy.yml`) runs the tests, builds the site, writes the pages a shared link opens (below), copies `index.html` to `404.html` so a link straight to any other page loads, and publishes `dist/` to GitHub Pages, which serves it at `askregulars.world` (`public/CNAME`). It also runs once a day, at 04:17 UTC, so the pages keep up with the list.

### Shared links

A link to a place, a chain or a fixed page (Trending, About and the rest), pasted where no app runs (a chat, a feed, a search engine), shows its own title, description and picture, and the address answers 200. After the build, `npm run share-pages` (`tools/share-pages.ts`, which loads `src/share/run.ts` through Vite) writes a copy of `dist/index.html` for each, with its own title and preview tags (`src/share/pages.ts`), at the file a host looks up for its address: `dist/place/<d>.html`, `dist/chain/<country>:<name>.html`, `dist/trending.html`. It writes `dist/sitemap.xml` and `dist/robots.txt` too, and the Regulars card, `public/og-card.png`, is the picture of every preview but a place's own photo.

```sh
npm run build && npm run share-pages
```

The step needs the hub. It reads the curator's list from `wss://dcosl.brainstorm.world` (`config.placesRelay`), writes nothing there, and checks every signature. Without an answer, or with fewer than 5,000 places (`SHARE_FLOOR` in `src/share/fetchPlaces.ts`), it writes nothing and fails, so the deploy stops and the site already live stays as it was. It is not part of `npm run build`: the Android release and the nSite carry no such pages. A reviewer's page, a review form and an address the app does not know still open through `404.html`, with the general preview. GitHub Pages answers `/x` from `x.html`; a host that does not has to be told to (nginx: `try_files $uri $uri.html …`).

Pull requests and other branches run the Test workflow (`.github/workflows/test.yml`): tests and a build.

## Operations notes

- **One request for the list.** The app reads the whole list in one request of up to 10,000 places (`DEFAULT_PAGE_SIZE` in `src/places/load.ts`), and assumes the relay's limit (its `max_limit`) allows that many. A relay with a lower limit sends a shorter answer, which the app takes for the whole list: a device that has a fuller copy keeps it, but a first visit shows only what came.
- **No more than 10,000 places at one `created_at`.** Paging goes back by time, and cannot get past a second that holds more places than one request returns. The importer must spread a larger run over more than one second.
- **Towns, at each monthly refresh of the places.** `src/data/towns.json` holds the towns the places are put in, cut down from GeoNames' list (cities1000, CC BY 4.0) to the ones the places need, so it goes stale as places are added. After each import, make it again from the live list, the places the app loads:
  1. Read the live list from the places relay, one event to a line, with [nak](https://github.com/fiatjaf/nak): `nak req -k 39999 -a <house key> -t z=<list coordinate> -l 10000 wss://dcosl.brainstorm.world > places-live.jsonl`. The key and the coordinate are `config.houseHex` and `config.headerCoordinate` in `src/config.ts`. Fewer than 10,000 lines is the whole list (see "One request for the list" above).
  2. Download `cities1000.zip` from <https://download.geonames.org/export/dump/> and unzip it.
  3. Run `node tools/towns.ts cities1000.txt places-live.jsonl --date <download day>` and commit the file. It prints how many towns and parts it kept, and the localities it keeps as towns of their own (El Zonte).

  The tool reads only those files; it asks no relay or server anything. Capitals whose districts GeoNames lists as towns, where the places carry no locality, take their districts in through a reviewed list, `tools/towns-absorb.ts` (Bangkok). Until the file is made again, a new place goes in the town its locality names, or the file's nearest town within 30 km, or, with none that near, in the town its locality names. The site never asks GeoNames anything; the countries' names come from the browser.
- **The daily deploy can stop by itself.** GitHub turns scheduled workflows off after 60 days without activity in the repository; if shared links stop picking up new places, turn the Deploy workflow's schedule back on in the Actions tab.
- **The Content Security Policy** is a meta tag the build writes into `index.html` (`tools/csp.ts`), with the hash of the theme's script, since GitHub Pages sets no headers. It lets the page reach its own files, OpenFreeMap's tile servers, Brainstorm's API and any `wss:` relay, run the scripts of sign-in add-ons, and show pictures from any https site. Code that reaches a new site needs it added there; `tests/csp.test.ts` fails on an address in the code that the policy refuses. A meta tag cannot set `frame-ancestors`, so the app keeps itself out of other sites' frames: in one, it draws only a link that opens it on its own (`src/shell/Framed.tsx`).
- **Reviews are read in batches of 50 places, two batches at a time.** A page asks for all its places at once (`src/score/store.ts`). Each batch is two requests to every review relay, side by side: one by the places' `a` tag and one by their `d`, so reviews written by other apps with a `d` alone are found too. A relay therefore has at most four of the app's review requests open at once (`BATCHES_IN_FLIGHT`); the other batches wait their turn. Each request asks for at most 500 reviews. One that comes back full is followed by the next page, back in time (`until` = the oldest review seen), so a place with hundreds of reviews (spam, say) can't push the other places' reviews in its batch out of the answer. A full page that gets no further back (more than 500 reviews in one second) is followed by one from the second before: the rest of that second is not read, and the older reviews are. A request reads at most 5 pages (`REVIEW_PAGES`, 2,500 reviews); past that, the batch is cut short. Names are read 100 people to a request, two requests at a time, and the house's ranks 500 people to a request, two requests at a time.
- **The house's view recovers.** House picks are unavailable only when the house's choice of scorer (kind 10040) can't be read, or its scorer's relay fails before it has given any rank. A rank read that fails later lets go of only that read's reviewers, who are asked about again at the next try; the places already ranked keep their scores. Explore and the place page offer Try again beside "House picks aren't available right now.", and the app tries again by itself when the browser says it is back on line, at most once in 5 seconds (`ONLINE_CALM_MS`), so a connection that comes and goes doesn't keep stopping reads that are doing well.

## Data and licence

Place data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright), gathered by [BTC Map](https://btcmap.org). The map: [OpenFreeMap](https://openfreemap.org) © [OpenMapTiles](https://www.openmaptiles.org/) © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Town names from [GeoNames](https://www.geonames.org), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`src/data/towns.json`). Code: MIT, see `LICENSE`. The licences of the packages the site is built from are in `THIRD_PARTY_NOTICES.txt` at the root of the built site.
