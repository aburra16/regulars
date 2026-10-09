# Decisions after the handoff

Avi's answers on 2026-10-07 to the questions in `handoff/START_HERE.md` and the gaps found on reading the handoff. Where this file and `handoff/REGULARS_APP_BRIEF.md` differ, this file wins. The handoff folder itself stays unchanged.

| # | Topic | Decision |
|---|---|---|
| 1 | Hosting | GitHub Pages on `askregulars.world`, built by GitHub Actions. The site is static: the browser reads relays and Brainstorm's API directly. The DigitalOcean droplet (174.138.89.23, running Trustwave) is kept for later server needs: a relay for reviews, share-link previews. |
| 2 | Stack | Vite, React, TypeScript, Tailwind (styles start from `handoff/design/tokens.css`), Nostrify for nostr, MapLibre GL for maps. Matches Trustwave. |
| 3 | Map tiles | MapTiler, with a custom style matched to the design tokens. Attribution "© MapTiler © OpenStreetMap contributors". Never OpenStreetMap's own tile servers. |
| 4 | Location search | Use the cities present in the places themselves. No calls to OpenStreetMap's Nominatim. |
| 5 | "Suggest a fix" | Opens an OpenStreetMap note at the place, not the editor. |
| 6 | House view | Mise en Place's view (its kind 10040 scorer), for everyone signed out and as the default signed in. |
| 7 | BTC Map credit | Fine print only: the About screen and the attribution line ("Place data © OpenStreetMap contributors, via BTC Map"). |
| 8 | Personalizing | Opt-in, as Unbnd does it: after sign-in, a Personalize action starts the calculation; a quiet banner while it runs (5 to 10 minutes); the House picks / My circle toggle turns on when ready. Nothing personalizes without that tap. No minimum-trust gate. |
| 9 | Screens | All of them: 15 phone, 6 desktop, plus the undrawn desktop pages and states (shown to Avi before being built out). |
| 10 | Launch city | Funchal (70 places within 25 km). An intermediate step; the whole build moves quickly. |
| 11 | House scores | Avi recalculates Mise en Place's scores frequently for now. |
| 12 | Vocabulary | No protocol or technical jargon anywhere a diner can see, beyond "Continue with Nostr" on sign-in and the "Bitcoin accepted" chip on a place page. "Trust", never "follow". The handoff's word list (npub, relay, event, web of trust, zap, DList, GrapeRank, follow, key, sign, kind numbers) is a minimum, not the whole rule. |
| 13 | Licences | The app is MIT (`LICENSE`). Dependencies are permissively licensed, except `opening_hours` (LGPL-3.0), which ships unmodified as its own chunk. |
| 14 | Review storage and format details | Deferred to build step 4 (brief § 4.2); its own conversation. |
| 15 | NosFabrica | Avi is a co-founder; Brainstorm API use and relay questions go to him directly. |

## Avi's answers on 2026-10-08, after M1 went live

| # | Topic | Decision |
|---|---|---|
| 16 | Review storage | Kind 34259 reviews go to `wss://search.brainstorm.world` and to the reviewer's own write relays. Reads from that relay carry `search: "include:spam"`, and the app applies its own line. "For now": the team may change the kind or shape later. Reviews already published then stay as they are, and the app reads both. |
| 17 | Review shape | `d` = `place:39999:<filer>:<d>`, `a` = the place address, `m` = `place`, `rating` = stars ÷ 5, `s` = stars, `alt` = "Review of <name>: <n> of 5 stars". This follows the existing 34259 convention of a `d` in the form `<type>:<id>`. |
| 18 | House line | A reviewer counts in House picks at rank 5 or more from Mise en Place's scorer (was 2). On 2026-10-08 that is 33,323 of the 60,700 people it ranks. |
| 19 | No numbers on people | A place shows its rating. A person never shows a trust number, rank, weight or meter. Reviewers appear by name only. The handoff's "How much this person counts" meter is dropped. |
| 20 | Place-page map | It can be zoomed and moved (Avi's request), and stays flat. This replaces the handoff's static map. |
| 21 | Signing in | Browser extensions (NIP-07) and every phone signer app (NIP-46: nostrconnect and bunker links). The person's key never reaches the app. |
| 22 | First reviewers | Avi seeds Funchal's first reviewers. People ranked 5 or more count at once; anyone else needs Mise en Place to follow them (or someone close), then a score recalculation. |

## Avi's answers on 2026-10-08, after reviews went live

| # | Topic | Decision |
|---|---|---|
| 23 | Signing in | Make it one tap where possible. With a browser add-on present, "Continue with Nostr" signs in at once. Without one (most phones), it goes straight to "Open the app" and the QR code. A small link offers the other way. Afterwards the person lands where they were, or on Explore (never a standalone page). |
| 24 | Where a first visit starts | Use the device's location if the browser already allows it, with no prompt. Otherwise guess from the device's time zone (nothing leaves the device) and start at the biggest nearby town with places. "Use my location" stays one tap away. Funchal is only the last fallback. |
| 25 | Zoomed-out map | Every place in view appears as pins, grouped into count bubbles at any zoom. The list shows the 50 places nearest the middle of the map, with a line like "2,345 places in view. Zoom in to see the rest." The 25 km cap on a searched area goes. |
| 26 | My circle consent | The deliberate Personalize tap is the consent, with one plain line beside it saying that Brainstorm works out their circle and the result is public. No separate consent screen. |
| 27 | Where Personalize is | Tapping "My circle" is the way in. For a signed-in person who hasn't personalized, the half reads "My circle" (not "soon") and opens a small panel right under the toggle, wherever the toggle is (Explore, Map, the desktop top bar). The panel holds decision 26's line, Personalize and Not now. Opening it asks Brainstorm nothing. While the add-on or phone app asks, the panel says so, with Cancel. "Soon" is shown only while the circle is being worked out. |

## Avi's answers on 2026-10-08, on a feed of recent reviews

| # | Topic | Decision |
|---|---|---|
| 28 | Recent | A feed of the newest reviews from the people behind the scores on screen (House picks' reviewers, or the person's circle and their own), newest first, in its own tab, "Recent" (renamed Trending, decision 31; a link in the desktop's top bar). It covers everywhere, with each place's distance; a "Near here" filter can come later. Order is by time only, and a person shows by name only (decision 19). |
| 29 | More review relays | Reviews are posted to and read from `wss://nos.lol` and `wss://relay.primal.net` as well as `wss://search.brainstorm.world` (decision 16), plus the reviewer's own write relays. A review counts as posted once any of the three takes it. Added on 2026-10-09, when NosFabrica's relay stopped taking writes (its storage node ran out of memory), so that Regulars never hangs on one relay. Whose reviews count is still decided by trust, so spam on public relays changes nothing. |
| 30 | Towns | Towns come from GeoNames' cities1000 (CC BY 4.0, credited on About), cut down at build time by `tools/towns.ts` to the towns the places need (`src/data/towns.json`, regenerated with each import). A place belongs to the town its locality names, else the nearest within 30 km; small districts fold into their city; a few capitals take in their districts by a reviewed list (Bangkok, Tokyo). Towns are named in English where GeoNames is, and found by their local names too. The search bar shows matching towns first, and places by name beyond here under "Elsewhere". |

## Avi's answers on 2026-10-09, on the wording of Explore

| # | Topic | Decision |
|---|---|---|
| 31 | Trending | Recent is renamed Trending, with a trending-up icon; the list stays the newest reviews from the people who count in the view, newest first, until there are enough reviews to rank places by recent activity (then: places ranked by how many people who count reviewed them in the last 30 days). |
| 32 | Units | Distances follow where the visitor lives, by the country of the device's time zone (tzdata's zone.tab): miles for the United States' zones and its territories (PR, VI, GU, MP, AS, UM), the United Kingdom (GB) and the Crown dependencies (JE, GG, IM), Liberia (LR) and Myanmar (MM); kilometres everywhere else. A zone in no country, or none, falls back to the browser's language. The "Within …" choices follow the unit. |
| 33 | Where distances are from | Every distance is from the place the "Near …" control names. It says "you" only for the device's location. A desktop's area searched on the map ("Search this area") is measured from the area's middle, and the control names it after the nearest listed town within 30 km of the middle, else "this map area"; picking a town or "Use my location" goes back. |
| 34 | Opening hours in colour | Wherever hours show, the state words are in colour: "Open" green, "Closed" red, and "Closing soon" amber when 45 minutes or less are left, with the closing time ("Closing soon · 4 pm"). Each has its own token, at 4.5 to 1 in both themes; the week's table on the place page stays plain. |
| 35 | Place page buttons | The place page's buttons read "Directions" (still "Get directions" to a screen reader, and to the eye when it is the only one), "Call" and "Website". On a phone they wrap when three do not fit. |
| 36 | Flagged reviewers | Reviews by people the house or the person's circle has muted or reported fold with everyone else outside the view: never counted, one tap to read, with no label of their own, so nothing reads as a verdict on a person. |
| 37 | BTC Map on About | About keeps naming BTC Map as the source that gathers the places, beside the OpenStreetMap credit. |
| 38 | Contact on About | No contact line on About for now. |
| 39 | What a reviewer gets back | A profile page: their name, picture and reviews, and later the lists they make that others can save. No counts about them (no "helpful" count), and no tips for now. |
| 40 | Standalone | Regulars stays its own site at askregulars.world, with Brainstorm as a named partner. Revisit if there is a reason to merge, such as a shared sign-in. |
| 41 | Korean font | Kept: Korean place names keep their font, at about 57 KB on the stylesheet. |
| 42 | Photos and a richer place page | After the backlog's low-hanging fruit. Explore public feeds for photos as well as reviewer uploads; the place page should become richer. |
| 43 | Trending's "Near …" | Trending shows the same "Near …" pill as Explore, opening the same town picker, so its distances say where they are measured from. |
