# Regulars M1: the signed-out app on real places — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Regulars to askregulars.world with the 7,954 live places loaded in the browser, and these screens working signed-out:
- Explore list and map, search, filters;
- chain and place pages, every place in the true "no reviews yet" state;
- About, and the sign-in screen as a display.

**Architecture:**
- **Static single-page app.** The browser reads the house curator's items from `wss://dcosl.brainstorm.world`, caches them in IndexedDB, and builds search, geographic and chain indexes in memory.
- **Responsive layout.** One app renders phone layouts below 900 px and the desktop layouts at 900 px and above.
- **Hosting.** GitHub Pages serves the build. Nothing is published to any relay in M1.

**Tech Stack:**
- Vite 8, React 19, TypeScript (strict), Tailwind 4 (theme from `handoff/design/tokens.css`), React Router 7, TanStack Query 5;
- `@nostrify/nostrify` (relay reads), `maplibre-gl` 6 with MapTiler;
- `opening_hours` 3.15 (LGPL-3.0, shipped unmodified as its own chunk), `@photostructure/tz-lookup`;
- `minisearch`, `kdbush` plus `geokdbush-tk`, `idb-keyval`;
- `@fontsource` Bricolage Grotesque, Figtree, Noto Sans and Noto Sans JP;
- Vitest with Testing Library (jsdom).

**Spec:**
- `handoff/REGULARS_APP_BRIEF.md`, the build brief. § 2, § 3.1, § 8, § 10, § 13 steps 1–2 and § 14 apply to M1.
- `handoff/design/` holds the screens (`SCREENS.md`, `screens/static/*.html`, `screens/source/*.dc.html`), `tokens.css`, `kinds.json` and `icons/`.
- `docs/decisions.md`. Where it differs from the brief, it wins.

## Global Constraints

- **Words.** "Nostr" appears only on the sign-in button ("Continue with Nostr"); "Bitcoin" only in the place page's "Bitcoin accepted" chip.
- **No jargon.** No protocol or technical vocabulary anywhere a person can see, in page titles and metadata too: npub, relay, event, web of trust, zap, DList, GrapeRank, follow, key, sign, kind numbers. Say "trust", never "follow"; say "sign in" and "post".
- **Copy in one module.** All user-visible strings live in `src/copy/en.ts`. A test fails on any banned word outside the two allowed strings (Task 1).
- **Errors are written for a diner:** "We couldn't load places. Try again." Never a URL, a status code or a stack.
- **The screens are the spec for layout, colour, spacing and wording.** Read exact values from `handoff/design/screens/source/<Name>.dc.html`. Build components; never paste the markup in. Ship none of the invented sample content.
- **Styling.** Colours, type, radii and sizes come only from the `tokens.css` variables. Touch targets are at least 44 px.
- **Network calls allowed in M1:**
  - the relay `wss://dcosl.brainstorm.world`;
  - MapTiler (tiles and style, only when `VITE_MAPTILER_KEY` is set).
  - Everything else is forbidden: no OpenStreetMap tile servers, no Nominatim, no font CDN (fonts are self-hosted), no analytics.
- **Attribution.**
  - On every map: "© MapTiler © OpenStreetMap contributors".
  - On place, search and chain screens: "Place details © OpenStreetMap contributors, via BTC Map".
  - BTC Map is named nowhere else except the About screen's fine print.
- **Place identity** is its address `39999:<curator pubkey>:<d>`. The route is `/place/:d`. Never use an event id.
- **Don't merge by name.** Chains group same-name places for display only; each location stays its own place.
- **Config in one file.** Everything configurable lives in `src/config.ts`: the name "Regulars", the domain `askregulars.world`, the house account `npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8`, the header coordinate `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places`, the places relay, and the default city. Nothing else hardcodes them.
- **Default city:** Funchal, centre `32.6507, -16.9084`, radius 25 km.
- **Units and time.** Distances in miles for en-US, en-LR and my-MM, otherwise km. Times follow the browser locale's 12- or 24-hour preference (`Intl.DateTimeFormat`).
- **Publish nothing.** M1 never publishes to any relay. Tests never open a network socket.

## Review Focus

1. **First load with the relay slow or unreachable.**
   - With a cache: the app shows cached places at once, with a quiet "Showing places saved on this device" line.
   - Without a cache: "We couldn't load places. Check your connection and try again." with a Try again button. Never a blank screen or an endless spinner. (Task 5)
2. **A relay answer that hits the request limit** must not silently truncate the list. Page backwards with `until` until a page comes back short. (Task 5)
3. **Unusual or broken hours strings** must never break a card or a page. Examples: `16:00 as 23:00`, `PH off`, `sunrise-sunset`, `Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+`, and the empty string. Unparseable hours show the raw text; missing hours show "Hours not listed". (Task 4)
4. **Location permission denied, or no geolocation:** Explore says "Near Funchal" with a working city picker, and no error dialog. (Task 7)
5. **A place with only name, kind and coordinates, a 67-character name, or a name in Japanese script:**
   - the page and card render with no overflow;
   - names wrap to at most two lines on cards;
   - non-Latin names render in Noto Sans.
   (Tasks 9 and 12)

---

### Task 1: Scaffold, tokens, copy module, deploy workflow

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/index.css`, `src/config.ts`, `src/copy/en.ts`, `public/CNAME`, `.github/workflows/deploy.yml`, `.github/workflows/test.yml`, `vitest.config.ts`
- Copy: `handoff/design/icons/*.svg` → `src/assets/icons/`, `handoff/design/kinds.json` → `src/data/kinds.json`
- Test: `tests/copy.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/config.ts
  export const config: {
    appName: "Regulars"; domain: "askregulars.world";
    houseNpub: string; houseHex: string;          // houseHex derived from houseNpub with nip19 at module load
    headerCoordinate: string; placesRelay: string; // "wss://dcosl.brainstorm.world"
    defaultCity: { name: "Funchal"; lat: number; lon: number; radiusKm: number };
    mapTilerKey: string | undefined;               // import.meta.env.VITE_MAPTILER_KEY
    features: { signIn: boolean };                 // false in M1
  };
  // src/copy/en.ts
  export const copy: Record<string, string | ((...a: any[]) => string)>;   // nested objects allowed; leaves are strings or template functions
  export const ALLOWED_PROTOCOL_STRINGS: { signInButton: "Continue with Nostr"; bitcoinChip: "Bitcoin accepted" };
  ```

- [ ] **Step 1: Scaffold.**
  - Set up Vite + React + TS strict, Tailwind 4 and Vitest (jsdom, Testing Library).
  - `src/styles/index.css` imports `tokens.css` content verbatim as the `:root` block and maps the tokens into Tailwind's `@theme`.
  - Self-host the fonts via `@fontsource`: Bricolage Grotesque 700/800, Figtree 400/600/700, Noto Sans 400/600/700, and Noto Sans JP 400/700 loaded only by `unicode-range`.
  - `index.html` title is "Regulars", with a meta description from `copy.meta.description`: "Restaurant ratings from people you'd actually ask."
- [ ] **Step 2: Write the failing tests.**
  - `tests/copy.test.ts`:
    - `no banned word appears in copy`: flatten every leaf of `copy` (call template functions with sample args). For each banned word, case-insensitive with word boundaries (`nostr, bitcoin, npub, relay, event, web of trust, zap, dlist, graperank, follow, followers, following, key, keys, sign, signed, signature`), expect no match except the two `ALLOWED_PROTOCOL_STRINGS` values.
    - `no banned word in index.html title or meta`.
    - Note: "sign in" is allowed, so the test treats the phrase "sign in" / "signing in" as permitted before checking `sign`.
  - `tests/config.test.ts`: `houseHex` equals `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64`; `headerCoordinate` matches `/^39998:[0-9a-f]{64}:food-and-drink-places$/`.
- [ ] **Step 3: Run** `npx vitest run`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement `config` and an initial `copy`** with the strings later tasks need, keyed by screen (`copy.explore`, `copy.place`, …). Later tasks add keys here.
- [ ] **Step 5: Add the deploy workflow** in `.github/workflows/deploy.yml`:
  - on push to `main`: `npm ci`, `npm test`, `npm run build`, then `cp dist/index.html dist/404.html`;
  - upload to Pages, using `VITE_MAPTILER_KEY` from repository secrets (absent is fine).
  - `public/CNAME` contains `askregulars.world`.
  - `.github/workflows/test.yml` runs tests on pull requests.
- [ ] **Step 6: Run** `npx vitest run && npm run build`. Expected: PASS, build succeeds.
- [ ] **Step 7: Commit** `chore: scaffold app, tokens, copy module, deploy workflow`.

### Task 2: Kinds, cuisines and the kind label

**Files:**
- Create: `src/places/kinds.ts`
- Test: `tests/kinds.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FamilyId = "restaurants"|"cafes"|"fast-food"|"bars"|"bakeries"|"ice-cream"|"farm-shops"|"food-shops"|"drink-shops"|"breweries";
  export interface KindInfo { family: FamilyId; familyLabel: string; label: string; icon: string /* svg url */ }
  export function kindOf(category: string): KindInfo;            // unknown → { family: "food-shops", label: titleCase(category), icon: food-shop.svg }
  export function cuisineLabel(cuisine: string): string;         // "coffee_shop" → "Coffee shop"; "bubble_tea" → "Bubble tea"
  export function placeKindLabel(category: string, cuisine?: string): string;
  export const FAMILIES: { id: FamilyId; label: string; icon: string }[];   // kinds.json order
  ```

- [ ] **Step 1: Write the failing tests:**
  - `kindOf("fast_food").label === "Fast food"`; `kindOf("biergarten").familyLabel === "Bars and pubs"`;
  - `kindOf("zz_new").label === "Zz new"` and the family is `"food-shops"`;
  - `placeKindLabel` table, which fixes the wording rule:

    | category | cuisine | result |
    |---|---|---|
    | restaurant | mexican | Mexican restaurant |
    | restaurant | — | Restaurant |
    | cafe | coffee_shop | Coffee shop |
    | cafe | bubble_tea | Bubble tea cafe |
    | bar | — | Bar |
    | pub | regional | Regional pub |
    | fast_food | burger | Fast food · Burger |
    | bakery | — | Bakery |
    | ice_cream | ice_cream | Ice cream |

  - `FAMILIES.length === 10`, in `kinds.json` order.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The rule:
  - for restaurant, cafe, bar and pub: `<Cuisine> <kind lower>`, except cafe with `coffee_shop`, which is "Coffee shop";
  - for any other kind: `<Kind> · <Cuisine>`, or the kind alone when there is no cuisine or the cuisine repeats the kind.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: kind and cuisine labels`.

### Task 3: The place model

**Files:**
- Create: `src/places/place.ts`, `tests/fixtures/funchal-items.json` (40 real items near Funchal plus 3 crafted edge items), `tests/fixtures/README.md` (ODbL attribution line)
- Test: `tests/place.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Place {
    address: string;            // 39999:<pubkey>:<d>
    d: string; pubkey: string;
    name: string; category: string; cuisine?: string;   // all cuisines are in `keywords` (t tags) for search
    lat: number; lon: number; geohash: string;
    street?: string; locality?: string; region?: string; postalCode?: string; country: string;
    phone?: string; website?: string; openingHours?: string; description?: string; image?: string;
    acceptsBitcoin?: "lightning"|"onchain"|"both"|"yes";
    osmId?: string; btcmapId?: string;
    keywords: string[];         // t tags
    createdAt: number;
  }
  export function parsePlace(ev: NostrEvent, headerCoordinate: string): Place | null;
  ```

- [ ] **Step 1: Build the fixtures.** Extract 40 Funchal items from `../mise-en-place/data/cache` with the importer's `buildItem` shape, then wrap them as kind 39999 event JSON with a fake `id` and `sig` and the curator pubkey. Add three crafted items:
  - name, category and coordinates only;
  - a 67-character name;
  - a Japanese name `ペーパー・クレーン`.
- [ ] **Step 2: Write the failing tests:**
  - **Fields:** fixture 0 parses with `address === "39999:4bded217…:" + d`, `lat` and `lon` are numbers, and `keywords` holds the `t` values.
  - **Rejected events** return `null`:
    - kind ≠ 39999;
    - no `z` tag equal to `headerCoordinate`;
    - missing `name` or `category`;
    - `lat`/`lon` not finite.
  - **Optional fields absent** give `undefined`, never `""`.
  - **`acceptsBitcoin` set** to any other value gives `undefined`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement `parsePlace`.**
  - Take the first value of each field; the `address` tag maps to `street`.
  - Use the 9-character `g` tag as `geohash`.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: place model`.

### Task 4: Opening hours

**Files:**
- Create: `src/places/hours.ts`
- Test: `tests/hours.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OpenState =
    | { kind: "open"; closesAt?: Date }       // closesAt undefined = open 24h / no end
    | { kind: "closed"; opensAt?: Date }
    | { kind: "unknown" }                     // no hours
    | { kind: "unparsed"; raw: string };
  export function openState(place: Pick<Place,"openingHours"|"lat"|"lon"|"country">, now: Date): OpenState;
  export function openLine(s: OpenState, locale: string, where: "card"|"place"): string;  // copy from src/copy/en.ts
  export function timeZoneOf(lat: number, lon: number): string;                           // IANA name via tz-lookup
  ```

- [ ] **Step 1: Write the failing tests.** `now` is fixed in UTC, and the place is in Funchal (`Atlantic/Madeira`).
  - `"Mo-Su 11:00-23:00"` at 15:00 local gives `open` with `closesAt` at 23:00 local. `openLine(…, "en-US", "card")` is `"Open until 11 pm"`; with `"pt-PT"` it is `"Open until 23:00"`.
  - The same hours at 23:30 give `closed` with `opensAt` the next day at 11:00, and `"Closed · opens 11 am"`.
  - `place` form: `"Open now · closes 11 pm"`.
  - `"24/7"` gives `open` with no `closesAt`; the line is `"Open 24 hours"`.
  - `undefined` gives `unknown`, `"Hours not listed"`.
  - `"16:00 as 23:00"` gives `unparsed`, and the line is the raw text.
  - `"PH off"`, `"sunrise-sunset"` and `"Mo-Fr 08:00-12:00,13:00-17:00; Sa 09:00+"` never throw (Review Focus 3).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `opening_hours` with `{ lat, lon, address: { country_code } }` for holidays.
  - Wrap every call in try/catch, so any throw gives `unparsed`.
  - Compute "now" in the place's time zone, using `tz-lookup` and `Intl`.
  - `vite.config.ts` puts `opening_hours` in its own chunk (`manualChunks`) and loads it lazily, so the LGPL code ships unmodified and separately.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: opening hours`.

### Task 5: Loading the places

**Files:**
- Create: `src/places/load.ts`, `src/places/store.tsx`
- Test: `tests/load.test.ts`

**Interfaces:**
- Consumes: `parsePlace` (Task 3), `config` (Task 1).
- Produces:
  ```ts
  export interface RelayReader { req(filter: Filter, signal: AbortSignal): AsyncIterable<NostrEvent> }  // injectable; prod = @nostrify NRelay1
  export async function fetchHousePlaces(reader: RelayReader, opts?: { pageSize?: number; signal?: AbortSignal }): Promise<{ places: Place[]; complete: boolean }>;   // pageSize default 10000 (dcosl's max_limit)
  export interface PlacesState { status: "loading"|"ready"|"error"; places: Place[]; source: "cache"|"network"; savedAt?: number; error?: string }
  export function PlacesProvider(props: { children: ReactNode; reader?: RelayReader }): JSX.Element;
  export function usePlaces(): PlacesState & { retry(): void };
  ```

- [ ] **Step 1: Write the failing tests,** with a fake `RelayReader` over the fixtures:
  - `fetchHousePlaces` sends `{kinds:[39999], authors:[config.houseHex], "#z":[config.headerCoordinate], limit: pageSize}`.
  - **Paging (Review Focus 2):** with `pageSize: 10` and 43 events with distinct `created_at`, a full page triggers the next query with `until` = oldest `created_at` seen. It dedupes by address and returns 43 with `complete: true`.
  - **No progress:** with `pageSize: 10` and 43 events all sharing one `created_at` (the importer signs a run at one time), the loop stops when a page adds no new address. It returns what it has with `complete: false`, and never loops forever. Production uses `pageSize` 10000, above the list's size, so this is a guard, not the normal path.
  - The newest event per address wins; `parsePlace` nulls are dropped.
  - **`PlacesProvider` (Review Focus 1):**
    - with an IndexedDB cache present (`fake-indexeddb`), it renders `source: "cache"` immediately, then `network` after the fetch;
    - with no cache and a reader that throws, it gives `status: "error"`, and `retry()` re-runs;
    - with a cache and a throwing reader, it stays `ready` from the cache.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The cache key is `places:v1:<headerCoordinate>` in `idb-keyval`, holding the raw events plus `savedAt`.
  - Refresh in the background on every app start.
  - The production reader wraps `NRelay1(config.placesRelay)` with a 20 s timeout, and closes it after EOSE.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: load and cache places`.

### Task 6: Indexes: geography, search, chains, cities

**Files:**
- Create: `src/places/indexes.ts`, `src/places/distance.ts`
- Test: `tests/indexes.test.ts`

**Interfaces:**
- Consumes: `Place` (Task 3), `placeKindLabel` and `cuisineLabel` (Task 2).
- Produces:
  ```ts
  export interface Indexes {
    near(lat: number, lon: number, radiusKm: number, limit?: number): { place: Place; km: number }[];   // sorted by km
    search(q: string, opts: { lat: number; lon: number; radiusKm?: number }): { place: Place; km: number }[];
    chainOf(place: Place): Chain | undefined;            // only when ≥ 2 locations share the chain key
    chains: Map<string, Chain>;                          // key = chainKey(name)
    cities: City[];                                      // localities with ≥ 3 places, sorted by count desc
    byD: Map<string, Place>;
  }
  export interface Chain { key: string; name: string; places: Place[] }
  export interface City { name: string; country: string; lat: number; lon: number; count: number }   // lat/lon = median of its places
  export function chainKey(name: string): string;        // lower-case, NFKC, ’→', collapse whitespace, strip trailing punctuation
  export function buildIndexes(places: Place[]): Indexes;
  export function formatDistance(km: number, locale: string): string;   // "0.6 mi" | "1.1 km" | "250 m" (km locales < 1 km)
  export function groupForList<T extends { place: Place }>(rows: T[], idx: Indexes): (T | { chain: Chain; nearby: T[] })[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - **`near`:** `near(32.6507, -16.9084, 25)` over the fixtures returns only fixtures within 25 km, sorted ascending.
  - **`search`:**
    - `search("cafe", …)` matches on kind labels;
    - `search("cafe")` also matches cuisine labels;
    - `search("Funchal")` matches locality;
    - `search("pizza")` matches cuisine;
    - a typo, `search("piza")`, still matches (fuzzy 0.2);
    - results are sorted by relevance, then distance.
  - **`chainKey`:** `chainKey("Steak 'n Shake") === chainKey("STEAK ’N SHAKE ")`.
  - **`chainOf`:** undefined for a unique name.
  - **`groupForList`:** two rows of the same chain become one `{chain, nearby:[2 rows]}` entry at the position of the nearer row; a single location stays a plain row.
  - **`cities`:** includes Funchal, with a count ≥ 30 in the fixtures.
  - **`formatDistance`:**
    - `(0.97, "en-US")` gives `"0.6 mi"`;
    - `(1.1, "pt-PT")` gives `"1.1 km"`;
    - `(0.25, "pt-PT")` gives `"250 m"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `kdbush` + `geokdbush-tk` for `near`.
  - `minisearch` over name (boost 3), kind label, cuisine label, locality and keywords; `prefix: true`, `fuzzy: 0.2`.
  - Build once per places array, memoized in the store.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: geographic, search and chain indexes`.

### Task 7: Where the person is

**Files:**
- Create: `src/location/useLocation.ts`, `src/location/CityPicker.tsx`
- Test: `tests/location.test.tsx`

**Interfaces:**
- Consumes: `Indexes.cities` (Task 6), `config.defaultCity`.
- Produces:
  ```ts
  export interface Here { label: string; lat: number; lon: number; source: "default"|"city"|"device"; denied?: boolean }
  export function useHere(): Here & { useDevice(): void; pickCity(c: City): void };
  export function CityPicker(props: { onPick(c: City): void; onUseDevice(): void; onClose(): void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests:**
  - **First visit:** `useHere()` gives `{label: "Funchal", source: "default"}`.
  - **Picking a city:** `pickCity(Lisbon)` persists across a remount (localStorage key `regulars.here`).
  - **Device location granted:** `useDevice()` with a mocked geolocation success gives `source: "device"`, `label` = the nearest city with "Near you" semantics: `copy.explore.nearYou`, which reads "Near you".
  - **Device location denied (Review Focus 4):** the source stays as before, `denied: true`, and the page shows `copy.location.denied`, the Funchal default and a working picker. No throw, no alert.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Only ask for device location when the person taps "Use my location". Never on load.
  - `CityPicker` lists `Indexes.cities` with a filter field.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: location and city picker`.

### Task 8: App shell, view toggle, attribution, banners

**Files:**
- Create: `src/shell/Shell.tsx`, `src/shell/TopBar.tsx` (desktop), `src/shell/TabBar.tsx` (phone), `src/shell/useWide.ts`, `src/ui/ViewToggle.tsx`, `src/ui/Attribution.tsx`, `src/ui/Banner.tsx`, `src/ui/KindTile.tsx`, `src/ui/Stars.tsx`, `src/routes.tsx`
- Test: `tests/shell.test.tsx`

**Interfaces:**
- Consumes: `usePlaces`, `useHere`, `config.features.signIn`.
- Produces:
  ```ts
  export function useWide(): boolean;                                        // matchMedia("(min-width: 900px)")
  export type View = "house" | "circle";
  export function ViewToggle(props: { value: View; onChange(v: View): void; scores?: { house?: number; circle?: number } }): JSX.Element;
  export function Attribution(props: { kind: "map" | "details" }): JSX.Element;
  export function KindTile(props: { category: string; size: "card"|"row"|"page" }): JSX.Element;
  export function Stars(props: { value: number /* 0–5, halves allowed */ }): JSX.Element;
  ```
  Routes:
  - `/` Explore;
  - `/map`;
  - `/search?q=&open=&kinds=&within=&sort=`;
  - `/filters`;
  - `/place/:d`;
  - `/chain/:key`;
  - `/about`;
  - `/signin`;
  - `/saved` and `/you`, which render the signed-out prompt in M1.

- [ ] **Step 1: Write the failing tests:**
  - **Layout by width:** at 390 px the tab bar shows Explore, Map, Saved and You, with no top bar. At 1360 px the top bar shows the wordmark, the search with its location, the toggle, Saved and the account, with no tab bar.
  - **The toggle in M1:** tapping My circle while `features.signIn` is false navigates to `/signin`, and the view stays `house`.
  - **Attribution text:** `Attribution kind="map"` reads "© MapTiler © OpenStreetMap contributors"; `kind="details"` reads "Place details © OpenStreetMap contributors, via BTC Map".
  - **Load banners:**
    - `usePlaces` with `source: "cache"` and a network error shows the banner "Showing places saved on this device";
    - `status: "error"` with no places renders the full-page error with a Try again button that calls `retry` (Review Focus 1).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** matching the top bar and tabs in `DeskExplore.dc.html` and `Main.dc.html`, and the toggle in `Main.dc.html` / `Place.dc.html`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: shell, toggle, attribution, banners`.

### Task 9: Explore list (screen 1)

**Files:**
- Create: `src/explore/ExploreList.tsx`, `src/ui/PlaceCard.tsx`, `src/ui/ChainCard.tsx`, `src/ui/Chips.tsx`
- Test: `tests/explore.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 7 and 8.
- Produces:
  ```ts
  export function PlaceCard(props: { place: Place; km: number; variant: "normal" | "unrated-dashed"; locale: string; now: Date; selected?: boolean }): JSX.Element;   // M1 always passes "normal"
  export function ChainCard(props: { chain: Chain; nearby: { place: Place; km: number }[]; locale: string }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests,** rendered with the fixtures, `here` = Funchal and a fixed `now`:
  - **Header:** "Near Funchal", the search field, the toggle on House picks with the line from `copy.explore.houseLine`, then the chips All, Open now, Restaurants, Cafes and More.
  - **Order:** cards come in distance order; a chain with two nearby locations renders one `ChainCard` ("<name> · N locations · 2 near you, the closest <d>").
  - **Unrated styling.** When no place in the list is rated (true for every list in M1), cards use the normal border and read `copy.score.noReviewsYet` ("No reviews yet"); dashed cards are reserved for unrated places in a list that has rated ones. This is a ruling for Avi to see.
  - **Chips:** "Open now" keeps only `open` places; "Restaurants" keeps the restaurants family.
  - **Long and non-Latin names (Review Focus 5):**
    - the 67-character name is clamped to two lines (`line-clamp: 2`);
    - the Japanese name has `lang="ja"`, set when the name contains CJK characters, which selects Noto Sans JP.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** matching `Main.dc.html` exactly. Show the first 30 rows, then load more on scroll.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: explore list`.

### Task 10: Search results and filters (screens 3 and 4)

**Files:**
- Create: `src/search/SearchPage.tsx`, `src/search/FiltersPage.tsx`, `src/search/filters.ts`, `src/ui/PlaceRow.tsx`
- Test: `tests/search.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface Filters { open: boolean; families: FamilyId[]; withinKm: 1|2|5|10|25; sort: "score"|"distance"|"name" }
  export function filtersFromParams(p: URLSearchParams): Filters;   // defaults: open false, families [], withinKm 25, sort "distance" in M1
  export function filtersToParams(f: Filters): URLSearchParams;
  export function applyFilters(rows: {place: Place; km: number}[], f: Filters, now: Date): {rows: {place: Place; km: number}[]; hiddenClosed: number};
  ```

- [ ] **Step 1: Write the failing tests:**
  - **URL round trip:** `filtersFromParams(filtersToParams(f))` deep-equals `f`.
  - **Open filter:** with `open: true`, closed places are removed and counted in `hiddenClosed`, while places with unknown or unparsed hours stay in.
  - **Header line:** the search page for "pizza" lists matching rows with the line `copy.search.summary(n, "Funchal", sortLabel)`.
  - **Hidden-closed note:** shows the count, plus `copy.search.hoursNote` ("Places without hours stay in").
  - **No results:** "No places match "<q>" near <city>." plus `copy.search.noResultsHint` and the "Add a missing place" link to `/about#add`, a placeholder until M4.
  - **Filters page:**
    - Sort offers My circle's score (disabled in M1, with `copy.filters.sortScoreSignedOut`), Distance and Name;
    - Open now;
    - Distance;
    - the ten families as a two-column grid with icons;
    - no payment filter. Applying returns to `/search` with the params.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** matching `Search.dc.html` and `Filters.dc.html`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: search and filters`.

### Task 11: Map (screen 2) and desktop Explore (D1)

**Files:**
- Create: `src/map/BaseMap.tsx`, `src/map/style.ts`, `src/map/pins.ts`, `src/explore/MapPage.tsx`, `src/explore/DeskExplore.tsx`
- Test: `tests/map.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function BaseMap(props: { center: [number, number]; zoom: number; interactive: boolean; pins?: Pin[]; selected?: string; onSelect?(address: string): void; onMoveEnd?(bbox: [number,number,number,number]): void }): JSX.Element;
  export interface Pin { address: string; lat: number; lon: number; label?: string /* score text; absent = unrated ring */; chainCount?: number }
  export function mapStyle(key: string | undefined): StyleSpecification | string;
  ```

- [ ] **Step 1: Write the failing tests.** MapLibre is mocked in jsdom.
  - **With a key:** `mapStyle("k")` returns the MapTiler `dataviz-light` style URL, with the key.
  - **Without a key:** it returns a local style with only a `background` layer coloured `--map-land`. No network URL appears anywhere in it.
  - **Pins:** an unrated place renders a ring marker. A chain with 3 visible locations renders one "×3" pin. More than 60 pins in view collapse into count clusters (MapLibre GeoJSON cluster source).
  - **Attribution:** "© MapTiler © OpenStreetMap contributors" is visible on the map.
  - **Map page:** "Search this area" appears after `onMoveEnd`, and tapping it re-queries `near` for the new bbox centre.
  - **Selecting a pin:** shows that place's `PlaceCard` docked at the bottom on phone; on desktop the list card gets the dark outline.
  - **Desktop Explore:** at 1360 px, the list (520 px) sits beside the map, with the filter menus (Open now, Kind of place, Distance, Sort) above the list.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - When a key is present, recolour the MapTiler style's land, park and water layers to the token values with `setPaintProperty` after load.
  - Lazy-load `maplibre-gl` in its own chunk.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: map and desktop explore`.

### Task 12: Place page (screens 6 and 7) and desktop Place (D2)

**Files:**
- Create: `src/place/PlacePage.tsx`, `src/place/ScorePanel.tsx`, `src/place/Facts.tsx`, `src/place/osmLinks.ts`
- Test: `tests/place-page.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function osmUrl(osmId: string): string;                       // "node:123" → "https://www.openstreetmap.org/node/123"
  export function osmNoteUrl(lat: number, lon: number): string;        // "https://www.openstreetmap.org/note/new#map=19/<lat>/<lon>"
  export function goUrl(p: Place): string;                             // "https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>" — NOT OSM's routing servers
  ```

- [ ] **Step 1: Write the failing tests:**
  - **Header:** a fixture place renders the kind tile, name, "<kind label> · <distance> away" and the open line in `place` form.
  - **Score panel, in the no-reviews state** (screen 7): "Be the first in your circle" and a "Rate this place" button. While `features.signIn` is false, that button goes to `/signin`.
  - **Actions:** only those the place has. Go is always shown; Call only with a phone, as a `tel:` link; Site only with a website.
  - **Facts:** address, hours (raw OSM hours expanded to a weekly table when parsed, raw text when not), phone, and a payment row with the "Bitcoin accepted" chip only when `acceptsBitcoin` is set.
  - **Missing facts:** "Hours not listed" in grey, plus the line `copy.place.missingDetails`, linking to `osmNoteUrl`.
  - **Footer:** "Something wrong? Suggest a fix" goes to `osmNoteUrl`, with the details attribution. There is no "Also listed by" in M1 (curator-only items).
  - **Unknown d:** `/place/osm-node-0` renders "No longer listed. It came off the map at the last monthly refresh." with a link back to Explore.
  - **Desktop (D2):** a content column plus a 320 px rail (Rate this place, Go/Call/Site, map, facts with the chip, Suggest a fix, attribution); review text measure 68ch.
  - **Sparse and edge places (Review Focus 5):** the name-only fixture renders with no empty labelled rows; the 67-character and Japanese names render without overflow at 390 px.
  - **Nearby:** "Nearby" lists the 3 closest other places. In M1, title the section `copy.place.nearby` ("Nearby") instead of "Nearby, rated by your circle", because nothing is rated.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** matching `Place.dc.html`, `PlaceNew.dc.html` and `DeskPlace.dc.html`. The hero map is a non-interactive `BaseMap`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: place page`.

### Task 13: Chain page (screen 5)

**Files:**
- Create: `src/chain/ChainPage.tsx`
- Test: `tests/chain.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - **Header:** "<name>", then "N locations · M near you", then `copy.chain.eachScored` ("Each location is scored on its own").
  - **Locations:** nearby locations are listed by street address, each with distance and open state. Unrated locations read "No reviews yet". "Show all N locations" expands the list.
  - **Chain pin:** the chain's map pin opens this page.
  - **Desktop:** the D2 layout pattern (content column plus rail with the map).
  - **Unknown key:** renders the "No longer listed" state.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** matching `Chain.dc.html`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: chain page`.

### Task 14: About, sign-in display, undrawn signed-out states

**Files:**
- Create: `src/about/AboutPage.tsx`, `src/signin/SignInPage.tsx`, `src/you/SignedOutPrompt.tsx`
- Test: `tests/about-signin.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - **About, figures:** About shows the live figures from the places store: place count, country count, and "last refreshed" = the newest `createdAt`, formatted as a date. The values in the design file are not hardcoded.
  - **About, content:**
    - the source fine print reads `copy.about.source` ("Place details from OpenStreetMap, gathered for us by BTC Map"), in small text;
    - the licence link points to `https://www.openstreetmap.org/copyright`;
    - the sections are "Where the reviews come from", "Who the house is" ("Mise en Place, our house curator"), "How signing in works" (anchor `#signing-in`) and "Your reviews are yours".
    - The contact address is omitted until Avi gives one.
  - **Sign in (screen 10 and D6):** matches the design, with "Continue with Nostr" and "Keep House picks". With `features.signIn` false, Continue is disabled, with `copy.signin.comingSoon` beneath it. "Keep House picks" returns to the previous page.
  - **Signed-out Saved and You:** `/saved` and `/you` show `copy.saved.signedOut` with a "Sign in" button that goes to `/signin`.
  - **Copy test:** `tests/copy.test.ts` still passes, with no banned words.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Draft copy for undrawn states goes in `src/copy/en.ts`, marked with a `// DRAFT for Avi` comment:
  - `location.denied`: "Location is off, so we're showing places near Funchal. Pick a city, or turn on location in your browser settings."
  - `offline`: "You're offline. Showing places saved on this device."
  - `load.failed`: "We couldn't load places. Check your connection and try again."
  - `search.noResultsHint`: "Try another spelling or a wider distance, or add a missing place."
  - `saved.signedOut`: "Sign in to save places and make lists you can share."
  - `signin.comingSoon`: "Signing in opens soon. Everything else works without it."
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: about, sign-in display, signed-out states`.

### Task 15: Ship and check (controller)

- [ ] **Step 1: Turn on Pages:**
  - `gh api -X POST repos/aburra16/regulars/pages -f build_type=workflow`;
  - then `gh api -X PUT repos/aburra16/regulars/pages -f cname=askregulars.world`.
- [ ] **Step 2: DNS records for Avi to add at Namecheap:**
  - apex `A` records 185.199.108.153, 185.199.109.153, 185.199.110.153 and 185.199.111.153;
  - `AAAA` records 2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153 and 2606:50c0:8003::153;
  - `CNAME www → aburra16.github.io`.
  - After the certificate is issued: `gh api -X PUT repos/aburra16/regulars/pages -F https_enforced=true`.
- [ ] **Step 3: Visual check.** Run `npm run dev` in the browser preview, at 390 px and 1360 px. For each built screen, compare it with `handoff/design/screens/static/<Name>.html` side by side. Fix mismatches through a fix task, and list any faults found in the design itself for Avi.
- [ ] **Step 4: Live check.** On the deployed site:
  - 7,954 places load, matching the importer's count;
  - opening Funchal shows real places;
  - search for "pizza" works;
  - a place page renders;
  - the network panel shows calls only to the relay, MapTiler and the site itself.
