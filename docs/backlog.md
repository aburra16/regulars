# Backlog

What is left, in one place, as of 2026-10-09 (after the polish batch). Sources: the brief's order of work (handoff/REGULARS_APP_BRIEF.md § 13), docs/m1-handover.md, and the build records at the end of each plan in docs/plans/. Decisions are in docs/decisions.md.

## Waiting on Avi

**Live checks**
- **My circle:** Personalize from your account, wait for "Your circle is ready", toggle, compare a place's score, then Update now (M3 Task 5).
- **Reviews:** a first real review from a phone app and from a browser add-on. Check that it reads back, is replaced on a re-post, renders in Brainstorm-UI, and is gone after removal (M2b Task 8).
- **Benjamin:** done. His review is live (decision 29); the review relay had run out of memory.

**Copy**
- Avi walked through every screen's wording on 2026-10-09. Two strings are marked DRAFT in `src/copy/en.ts`: `reviews.uncounted` ("2 reviews, shown without a rating for now"), reworded after his pass, and `framed.open` ("Open Regulars"), the one link the site shows in another site's frame.

**Product calls**
- All settled on 2026-10-09 (decisions 36 to 43).

**For the team**
- **NosFabrica relay team:** search.brainstorm.world refused every write from about 22:20 UTC on Oct 8 (`NO_SPACE`: its Vespa content node's memory over the feed-block limit). More machines are coming; nothing to change in the app when it is back (decision 29).
- **Brainstorm:** a count of a person's circle at rank 5 would make "N people in your circle" exact; today it is a floor.

**Housekeeping**
- Move the repo out of iCloud-synced `~/Documents`. Sync keeps making " 2" copies, and once reverted a file.

## Next features (brief § 13 order)

1. **Trust button with the § 7 safeguards, and the person page.** The page has names only, with no "how much this person counts" meter (decision 19). It must be tested against an account with an existing follow list, preserving every entry.
2. **Saved lists**, now hidden behind `features.saved`.
3. **Add or fix a place.** Today "Add a missing place" opens an OpenStreetMap note; the in-app form comes later.
4. **Tags**, once the W20 fix on `feat/tags` lands.
5. **A "Near here" filter on Trending.**
6. **Trending ranked by recent activity,** once there are enough reviews: places ranked by how many people who count reviewed them in the last 30 days (decision 31).
7. **Growth beyond Funchal.** The map already shows every place; this needs a plan for seeding first reviewers.
8. **A richer place page, with photos** (decision 42): explore public photo feeds as well as reviewer uploads. After the low-hanging fruit.
9. **A reviewer's profile page** (decision 39): name, picture and reviews; later their lists. No counts.

## Hardening before many people use it

- **Deep links answer HTTP 404.** GitHub Pages serves every address other than `/` through `404.html` (the app's copy), with status 404. The page works in a browser, but link previews and search engines may treat a shared place page as missing. Options: prerender the place pages at build time, or move to a host with single-page rewrites (Cloudflare Pages, Netlify).

- **The importer** (in the mise-en-place repo; still open): never more than 10,000 places at one `created_at`, or returning visitors stay on their saved copy.
- **Duplicates:** the same venue mapped twice within 50 m shows twice.
- **CI:** `ubuntu-latest` moves to Ubuntu 26 on 19 October; watch the first run after.

## Small deferred items

**My circle** (M3 record)
- After a long "Work out my circle again", the view goes back to My circle by itself.
- No line explains why a retry that was put back failed.
- A "counting" flash on promotion.
- Contradictory lines when the circle relay is down while unconfirmed.
- A done run whose `/setup` keeps returning 404 polls until the 45-minute cap.

**Posting** (P1, P2)
- Up to 3 copies of a review are queued at the review relay.

**Towns** (GeoNames, decision 30)
- English names GeoNames lacks: "Cologne" finds nothing (GeoNames says Köln). English preferred names from `alternateNamesV2` would fix it.
- Review the US parts: "Zionsville" finds Indianapolis, "Chapel Hill" Durham, "Daly City" San Francisco, "Inglewood" Los Angeles.
- Odd GeoNames names among the aliases ("Gare" for Paris, a bus barn for Washington): harmless, noisy.
- Pairs that are one place: El Zonte and Playa El Zonte, Masimba and "Masimba ward".
- Antiguo Cuscatlán (88 places) outnumbers San Salvador (84); the first visit still starts in San Salvador.
- Bangkok's Lat Krabang and Min Buri, and Tokyo's outer wards (Ōta, Katsushika), sit past the absorb reach and stay their own towns.
- `towns.json` is 159 KB raw (73 KB gzip) and grows at each refresh; regenerate it with each monthly import (README).

**Trending** (decisions 28 and 31; the code keeps the name Recent)
- The list is rebuilt on every store change (fine at today's scale).
- The rank-failure flag is per view, not per person, so a brief false failure line is possible.

**Reviews and sign-in** (M2b record)
- Cards redraw once when the house becomes ready.
- No targeted retry of failed places.

**Focus after navigation** (the polish batch)
- A page with no `h1` (Not found, a page that broke, a place still being looked for) leaves the focus where it was.
- A new search from the results (the same pathname) never moves the focus; the first, from Explore's top bar, leaves it in the field.

**Search, signatures and the policy** (the hardening batch)
- Two words apart in a Thai or Chinese name, typed with no space between them ("ร้านมาลี"), don't find it; with a space they do. Splitting the query into words as well broke words typed in part.
- Under attack, a forged newer version of a place hides the real one: the newest version at each address is kept before the signatures are checked, so that place is gone until a clean load.
- The first signature check of a visit takes about 20 ms on a desktop (the curve's tables), past the 16 ms aim for a slice; each later one about 1 ms.
- MapLibre's worker takes its policy from the headers its file is served with, so the meta tag's doesn't reach it.
- A first visit that finds a forged place, with no saved copy, shows "loading" for the whole list's check: about 9.5 s on a desktop, longer on a phone.

**Tests and proof** (M2a record)
- Proof marker tags.
- README nits.
- More guard-test cases.
