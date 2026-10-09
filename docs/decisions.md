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
