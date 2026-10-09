# Backlog

What is left, in one place, as of 2026-10-09. Sources: the brief's order of work (handoff/REGULARS_APP_BRIEF.md § 13), docs/m1-handover.md, and the build records at the end of each plan in docs/plans/. Decisions are in docs/decisions.md.

## Waiting on Avi

**Live checks**
- **My circle:** Personalize from your account, wait for "Your circle is ready", toggle, compare a place's score, then Update now (M3 Task 5).
- **Reviews:** a first real review from a phone app and from a browser add-on. Check that it reads back, is replaced on a re-post, renders in Brainstorm-UI, and is gone after removal (M2b Task 8).
- **Benjamin:** re-posts his Casper Fermentables review. His first one never reached Regulars' relay.

**Copy**
- The UI wording marked DRAFT in `src/copy/en.ts` needs a pass.

**Product calls**
- **Recent on the phone has no "Near …" line,** so its distances are from wherever Explore last looked. Add one?
- **Photos:** the recommendation is photos attached to reviews, stored on a nostr file server we choose, shown only from people who count. For discussion; not scheduled.
- **Open from the brief (§ 12):**
  - flagged reviewers: folded with the rest, or hidden;
  - whether About names BTC Map;
  - About's contact address;
  - what a reviewer gets back;
  - whether to fold into brainstorm.world later.
- **Korean font:** keep the coverage, or drop it to save about 57 KB per visitor.

**For the team**
- **NosFabrica relay team:** search.brainstorm.world never took event `b0d56230…` (around 01:15 UTC on Oct 9). Check the IngestQueue logs and whether the FTS reindex was running.
- **Brainstorm:** a count of a person's circle at rank 5 would make "N people in your circle" exact; today it is a floor.

**Housekeeping**
- Move the repo out of iCloud-synced `~/Documents`. Sync keeps making " 2" copies, and once reverted a file.

## Next features (brief § 13 order)

1. **Trust button with the § 7 safeguards, and the person page.** The page has names only, with no "how much this person counts" meter (decision 19). It must be tested against an account with an existing follow list, preserving every entry.
2. **Saved lists**, now hidden behind `features.saved`.
3. **Add or fix a place.** Today "Add a missing place" opens an OpenStreetMap note; the in-app form comes later.
4. **Tags**, once the W20 fix on `feat/tags` lands.
5. **A "Near here" filter on Recent.**
6. **Growth beyond Funchal.** The map already shows every place; this needs a plan for seeding first reviewers.

## Hardening before many people use it

- **Place signatures:** check them in the browser, in a worker or by sampling. Today they are off for speed.
- **The importer:** never more than 10,000 places at one `created_at`.
- **Focus:** move it to the new page's heading after navigation (for screen readers).
- **Search:** Thai and Chinese names aren't split into words.
- **Duplicates:** the same venue mapped twice within 50 m shows twice.
- **Postcodes:** bound the length of a run kept on one line.
- **Content Security Policy:** a meta tag (a hardening idea from M2b).
- **CI:** `ubuntu-latest` moves to Ubuntu 26 on 19 October; watch the first run after.

## Small deferred items

**My circle** (M3 record)
- After a long "Work out my circle again", the view goes back to My circle by itself.
- No line explains why a retry that was put back failed.
- A "counting" flash on promotion.
- Contradictory lines when the circle relay is down while unconfirmed.
- A done run whose `/setup` keeps returning 404 polls until the 45-minute cap.

**The My circle panel** (decision 27)
- On the Map, and on desktop pages other than Explore, nothing shows "working out your circle" once the panel closes.
- Desktop Explore shows two Try again buttons when a run failed.

**Posting** (P1, P2)
- "Still posting…" can linger up to 7 s after a refusal while an own relay hangs.
- Up to 3 copies of a review are queued at the review relay.

**Recent** (decision 28)
- The list is rebuilt on every store change (fine at today's scale).
- The rank-failure flag is per view, not per person, so a brief false failure line is possible.

**Reviews and sign-in** (M2b record)
- A sign-in with no "from" lands on /you.
- "Open the app" is chosen by layout width, not device.
- Cards redraw once when the house becomes ready.
- No targeted retry of failed places.
- The empty focus target after removing your only review has no name.

**Tests and proof** (M2a record)
- An order-dependent config test pair.
- Proof marker tags.
- README nits.
- More guard-test cases.
