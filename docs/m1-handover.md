# M1 handover: the signed-out app on real places

M1 was built overnight on 7–8 October 2026, from `docs/plans/2026-10-07-m1-signed-out-app.md`.

**What it is**
- Explore (list and map), search, filters, place, chain, about, the sign-in display, and the signed-out Saved and You pages.
- It runs on the 7,954 places of the Food and Drink Places list. Every place is in the "no reviews yet" state.

**How it was built and reviewed**
- Each of the 14 tasks was built by one agent, then reviewed by a fresh agent, with fix rounds until the review was clean.
- After that came a review of the whole branch and a screen-by-screen visual check against `handoff/design/`.
- One wave of fixes followed, then a re-review.

## Where it stands

- **Code:**
  - `main`, deployed by the Pages workflow.
  - 1,717 tests pass, and CI is green.
  - GitHub Pages serves the site for `askregulars.world`, checked by asking GitHub's servers for that name directly.
- **Live:** yes, at https://askregulars.world, since 8 October 2026.
  - The DNS records are in, the certificate is issued and HTTPS is enforced.
  - The MapTiler key already allowed the domain, so the maps draw.
  - The app needs HTTPS to load places (see "Done" below).

## Done on the morning of 8 October

- **DNS.** Avi added the GitHub Pages records at Namecheap.
- **Certificate.** GitHub had not asked for one, because the custom domain was set before DNS pointed at it. Re-saving the domain started it, and it was approved within a minute.
- **HTTPS enforced.**
- **Why HTTPS matters here.** Over plain HTTP the app can't load places: Nostrify calls `crypto.randomUUID`, which browsers only provide on secure pages. HTTPS enforcement redirects plain HTTP, so visitors never meet this.

## What needs you

1. **Namecheap.** Delete the leftover "URL Redirect Record" at `@` (to `http://www.askregulars.world/`). It comes from the parking setup. It isn't answering today, but it competes with the A records at `@`.
2. **MapTiler.** Nothing to do. The key already accepts askregulars.world (style, tiles and fonts answer 200).
3. **Draft copy.** There are 45 strings marked `// DRAFT for Avi` in `src/copy/en.ts`. All are invented, for states the design does not draw. The ones people see most:
   - the empty, offline and failure states;
   - "Signing in opens soon. Everything else works without it.";
   - the About page's two paragraphs on House picks and on the house (`about.viewsBody`, `about.houseBody`);
   - "Best match first";
   - the You page's "Sign in to see your reviews and the people you trust."
4. **Design asks:**
   - a favicon (there is none; the page declares an empty one);
   - the design faults below.
5. **Font weight against coverage.** Place names in Korean (24), Thai (58), Lao (2) and Arabic (1) now draw in Noto. The Korean face's slices add about 57 KB (gzip) to the stylesheet every visitor loads, though the font files themselves load only when a Korean name is on screen. You could drop Korean to save that, or keep coverage.
6. **The repo lives in iCloud-synced `~/Documents`.**
   - Sync made " 2" copies of files (in `node_modules`, `dist`, `.git/index 2` and the icons), and once quietly reverted a source file mid-session. The tests caught that one.
   - Moving the checkout out of `~/Documents`, or excluding it from sync, would stop this. The same goes for `mise-en-place`.
7. **Still open from the brief:**
   - review storage (decision 14, brief §4.2);
   - whether sign-in needs Brainstorm-UI's consent step (§6).

## Design faults found in the visual check

1. `tokens.css` doesn't say the display face needs its optical-size axis. It has no line-height tokens either, so any framework default drifts.
2. SignIn.html says "who you already follow"; DeskSignIn.html says "trust". The app uses "trust".
3. About.html has the placeholder "Questions: [CONTACT ADDRESS]". The app leaves that line out.
4. DeskExplore's top-bar toggle and filter menus are 40 px, under the 44 px touch token. The app follows the design.
5. DeskPlace's top bar drops the toggle and the location pill. The brief says one top bar on every page.
6. The card layout differs between Main, DeskExplore and Map's docked card. No screen shows a signed-out card for a place nobody has reviewed, which is every card at launch.
7. Map.html credits only OpenStreetMap; MapTiler's credit is required. Its attribution colour is not a token.
8. Filters.html's distances assume miles ("½ mi, 1, 2, 5, Any"). The app uses 0.5/1/3/5/15 mi, or 1/2/5/10/25 km, by locale.
9. Some signed-out states are not drawn:
   - the disabled "My circle's score" sort;
   - Open now switched off;
   - an empty "Search this area";
   - signed-out You and Saved;
   - the desktop place page with no reviews.
10. A selected chip drops its border and gets 3 px narrower, which shifts its neighbours. The app keeps the width.
11. "How this works" on Main is a 17 px inline link, and it is the only way to the explanation.
12. Chain's "See on map" goes to the generic map. The app opens the map at that location.
13. The credit footers leave out BTC Map. The app says "via BTC Map", per decisions §7.

## Kept as built, against the design (your call)

- **The search field's focus ring.** The design shows none; a visible focus ring is an accessibility need.
- **"No reviews yet" on cards.** It sits in the line about who rated the place, with the score slot left empty, so long names keep their width.
- **Desktop cards.** They keep the phone's stacked lines.
- **Hours.** The place page shows a 7-day table, not a one-line summary.
- **Chain rows.** They show the full address.
- **Distance choices.** They are per unit system (see design fault 8).
- **"Use my location".** The phone map has this button.
- **Continue on sign-in.** It is greyed while signing in is off.

## Follow-ups worth doing before many people use it

- **Signature checks.** Verify the places' signatures in the browser. They are off for speed: the relay is NosFabrica's own, and checking took 6.7 s on a desktop. That needs a worker or a sampled check.
- **The importer.** It must never put more than 10,000 places at one `created_at`, or returning visitors stay on their saved copy. The app reads the list in one request of up to 10,000 (dcosl allows 10,000).
- **Focus on page change.** After moving to another page, focus is left on the page body. Screen-reader users need it moved to the new page's heading.
- **Search.** Thai and Chinese names aren't split into words.
- **Duplicate venues.** The same venue mapped twice within 50 m shows twice.
- **Postcode runs.** The rule that keeps a postcode on one line has no length limit. A hostile address with a 100-character run of digits and hyphens would push its row wider. Bound it at about four parts of ten digits.
- **CI's runner.** `ubuntu-latest` moves to Ubuntu 26 on 19 October; watch the first run after.

## Rulings made during the build

These are the decisions I took on your behalf, in order, each with what it costs if wrong.

- **R1** Work on branch `feat/m1-signed-out`. Cost if wrong: none.
- **R2** Placeholder pages until each task built its own. Cost if wrong: none.
- **R3** Search's "Add a missing place" opens an OpenStreetMap note at the town (the in-app form is M4). Cost if wrong: the link changes later.
- **R4** I ran Task 15 (Pages, DNS records, the checks) myself.
- **R5** Small setup acceptances (Noto Sans JP root override, an empty MapTiler key counts as no key). Cost if wrong: cosmetic.
- **R6** The copy gate also catches inflections and kind numbers, and allows the two exceptions only at their own keys. Cost if wrong: a stricter gate.
- **R7** "Sign out", "signed in" and "signed out" count as plain language, not protocol words. Cost if wrong: rewording in M3.
- **R8, R36** Small related tasks were built and reviewed together.
- **R9** A curator place without a geohash is skipped. Cost if wrong: places you file by hand need it (M4).
- **R10, R11** Hours the parser can't be sure of (sunrise, "+", odd syntax, parser auto-corrections, a change into "unknown") show as raw text, never a guessed "Open". English weekday names come from copy. Cost if wrong: some places show raw hours text.
- **R12, R13** Event shapes are checked by hand-written code. Signatures are not checked yet (see follow-ups). Cost if wrong: a compromised relay could slip in fake places until checks land.
- **R14, R15** The saved copy on the device:
  - an incomplete load is kept only when nothing was saved before;
  - a full load with under half the saved count is treated as a failure.

  Cost if wrong: a real halving of the list would need a code change.
- **R16** The nearest-neighbour search (ISC) is vendored. Miles are used by region (en-US, en-LR, my-MM). Cost if wrong: units for some locales.
- **R17–R20** Towns, chains and search:
  - **Towns:** each is the densest 25 km cluster of its name and region; names that repeat get their region, e.g. "Lexington, KY".
  - **Chains:** a chain is the same name plus country; placeholder names never chain.
  - **Kind words:** a word that names a kind ("coffee", "pizza") lists those places by distance.
  - **Other words:** these list best match first.
  - **Cuisines:** a cuisine joins the kind words only when at least 5 places carry it.

  Cost if wrong: search tuning.
- **R21–R23** Shell and layout:
  - one breakpoint (900 px);
  - full desktop top bar everywhere except sign-in;
  - the design's sizes win over my guesses;
  - dialogs lock scroll and focus.
- **R24, R25** Cards with no reviews say so in the line about who rated the place, not where the score goes. Cost if wrong: one layout change when scores arrive.
- **R26** The hours parser caches 3,000 entries, because 10,000 would cost a phone about 250 MB. Cost if wrong: slower repeat parsing.
- **R27, R28** Sorting and distances:
  - with no sort chosen, kind words sort by distance and other words by best match;
  - distance steps are per unit system;
  - the URL stores km.

  Cost if wrong: product tuning.
- **R29** Search's back arrow returns to the exact Explore it came from.
- **R30–R32** Map behaviour:
  - after "Search this area", distances are still from your device when it has said where you are;
  - only pins on screen take keyboard focus;
  - Back restores the map view.
- **R33, R34** I removed the place photo I had asked for. It broke "No photographs anywhere" (brief §10) and would have sent visitors' IPs to image hosts. The place pin is the design's teardrop.
- **R35** Small hours edge cases parked: SH holidays shown raw; a rare split across midnight.
- **R37, R38** Sign-in uses "We read who you already trust." "Show all N locations" shows all of them, up to 500.
- **R39** The scope of the final fix wave, 30 items. The main ones:
  - CI's timing test;
  - licence notices;
  - slow-network timeouts;
  - older iPhones;
  - attribution under the phone list;
  - "away" only from your device;
  - the variable display font;
  - line height;
  - desktop search in the list-and-map layout;
  - Thai, Korean, Lao and Arabic fonts.
- **R40** The visual differences in "Kept as built" above.
- **R41** No second fix wave. The last two small items (the postcode hyphen font and the Tailwind licence credit) went in as a reviewed follow-up before DNS.
- **R42** Withdrawn: the map's fit already has padding.

The full ledger, with every review finding, lived in the build's working folder. The git history is the record now.
