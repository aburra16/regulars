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
