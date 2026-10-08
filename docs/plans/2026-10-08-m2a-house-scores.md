# M2a House Scores Implementation Plan

> **Status (2026-10-08, overnight):** written while Avi was away. Tasks 1–4 (engine and local proof) were executed under his instruction to keep going; Tasks 5–7 wait for his review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brief §13 step 3. Work out House picks scores at read time:
- resolve the house's scorer from its kind 10040;
- read the scorer's kind 30382 ranks for the reviewers of the places on screen;
- read kind 34259 reviews;
- compute each place's score.

Show scores on cards, pins and the place page. Prove all of it against a **local** relay with throwaway keys.

**Architecture:**
- Four pure modules:
  - review parsing;
  - rank parsing;
  - scorer resolution;
  - score maths.
- One session store (`ScoresProvider`) fetches reviews for the addresses that pages ask about, and the house's ranks for their reviewers. It caches both in memory for the session and recomputes from them. It never stores a score.
- **Production is unchanged until Avi settles review storage** (decision 14, brief §4.2): `config.reviewRelays` is `[]` in production, so the store makes no request and every place stays "No reviews yet".
- Dev and the local proof set `VITE_REVIEW_RELAYS` and a dev-only scorer override.

**Tech Stack:** as M1: Nostrify NRelay1, React 19, Vitest; nostr-tools for test keys and signing in the proof script only.

**Spec:**
- handoff/REGULARS_APP_BRIEF.md §3.2 (house scores), §4 (review format), §5 (scoring), §13 step 3;
- docs/decisions.md (6 house view, 11 house scores, 12 vocabulary, 14 review storage deferred).

## Global Constraints

- **Point of view.** Never store a per-viewer score. Store raw reviews and ranks, and compute at read time (brief §5, rule zero).
- **Weights:**
  - `weight = rank / 100` when `rank >= config.scoring.line` (line = 2, Brainstorm's verified line 0.02 × 100);
  - otherwise 0;
  - a reviewer with no 30382 is outside (weight 0).
- **Score.** `score = Σ weight × stars / Σ weight` over weight > 0; `counted` = the number of reviewers with weight > 0.
- **Ordering key.** `(Σ w×s + priorWeight × priorMean) / (Σ w + priorWeight)` with priorWeight 1.5 and priorMean 3.5, in `config.scoring`.
- **Folding.** Reviews outside the view are folded, never dropped.
- **Stars:** copy Brainstorm-UI's `starsOf`:
  - an `s` tag of 1–5 (integer) wins;
  - else the first `rating` with no third element;
  - else the first `rating`;
  - a value ≤ 1 → × 5; a value ≤ 5 → raw stars; else null.
  - A review with null stars shows its text but does not enter a score.
- **Review identity.** A review's subject is the place address `39999:<hex64>:<d>`, from `a` if it is such an address, else `d`. Use the newest per (reviewer, address); ties go to the lower id.
- **Scorer chain:**
  - resolve the scorer at run time, from the newest kind 10040 by `config.houseHex`;
  - use the first tag `["30382:rank", <scorer hex64>, <wss url>]`;
  - never hardcode `151466c4…`.
- **Network:**
  - new hosts are only `config.houseTrustRelays` (`["wss://scores.brainstorm.world"]`), the scorer's relay named in the 10040, and `config.reviewRelays`;
  - nothing is contacted until there is at least one review to weigh: no reviews → no 10040 read, no rank read.
- **Vocabulary.** Copy as in M1: banned words stay banned; say "trusts" and "house"; new strings are marked `// DRAFT for Avi`.
- **Test data.** Never published to a non-local relay. The proof script refuses any relay URL whose host is not localhost, 127.0.0.1 or [::1].

## Review Focus

1. **A 30382 by the scorer with a non-numeric, negative or > 100 `rank`:** the reviewer counts as outside, with no NaN anywhere. Test in Task 2.
2. **A reviewer with two reviews of one place, and a deleted review (the relay stops returning it):** only the newest counts, and a refetch that no longer returns it drops it. Test in Task 1 and Task 5.
3. **Reviews arrive for a place before the ranks:** the card shows "No score yet" with the folded count, never a score from unweighted stars. Test in Task 5.
4. **The scorer's relay is down, or the 10040 is missing:** every review is folded, the line says the house's view is unavailable, and nothing throws. Test in Task 2 and Task 5.
5. **A `rating` of exactly "1":** read as a fraction (5 stars), as `starsOf` does. Test in Task 1.

---

### Task 1: Review model and reader-per-relay

**Files:**
- Create: `src/reviews/review.ts`, `tests/review.test.ts`
- Modify: `src/places/relayReader.ts` (generalise it to any relay), `src/config.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REVIEW_KIND = 34259;
  export interface Review { id: string; reviewer: string; address: string; stars: number | null; text: string; createdAt: number }
  export function starsOf(tags: string[][]): number | null;
  export function parseReview(value: unknown): Review | null;           // shape-checked like asEvent
  export function latestReviews(values: readonly unknown[]): Review[];  // newest per reviewer+address
  export function readerFor(url: string): RelayReader;                  // relayReader.ts; same timeouts as the places reader
  // config additions
  reviewRelays: string[];            // [] in production; VITE_REVIEW_RELAYS (comma list) in dev only
  houseTrustRelays: string[];        // ["wss://scores.brainstorm.world"]
  scoring: { line: 2; priorWeight: 1.5; priorMean: 3.5 };
  devScorer?: { pubkey: string; relay: string };  // VITE_DEV_SCORER="<hex>@<ws url>", only when import.meta.env.DEV
  ```

- [ ] **Step 1: Write failing tests.**
  - `starsOf`:
    - `[["s","4"]]` → 4;
    - `[["rating","0.800"]]` → 4;
    - `[["rating","1"]]` → 5;
    - `[["rating","3"]]` → 3;
    - `[["rating","7"]]` → null;
    - `[["s","0"],["rating","0.6"]]` → 3;
    - `[["rating","0.9","speed"],["rating","0.4"]]` → 2.
  - `parseReview`:
    - takes `a` when it is a 39999 address, else `d`;
    - rejects a review whose subject is not a 39999 address;
    - rejects a wrong kind, a bad pubkey or a non-string content.
  - `latestReviews`: two reviews by one reviewer of one place keep the newer; a tie keeps the lower id.
  - `readerFor(url)`: the places reader still reads `config.placesRelay` (an existing test, adjusted).
  - `config`: `reviewRelays` is `[]` when `VITE_REVIEW_RELAYS` is unset; a non-ws(s) entry is dropped; `devScorer` is undefined in production builds.
- [ ] **Step 2: Run** `npx vitest run tests/review.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `readerFor` is the existing reader with the URL as a parameter.
  - `relayReader` becomes `readerFor(config.placesRelay)`.
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: review model and a reader for any relay`.

### Task 2: House weights

**Files:**
- Create: `src/trust/houseWeights.ts`, `tests/houseWeights.test.ts`

**Interfaces:**
- Consumes: `readerFor`, `config.houseHex`, `config.houseTrustRelays`, `config.devScorer`, `config.scoring.line`
- Produces:
  ```ts
  export interface Scorer { pubkey: string; relay: string }
  export function scorerFrom(values: readonly unknown[], house: string): Scorer | null;    // newest valid 10040 by house
  export function ranksFrom(values: readonly unknown[], scorer: string): Map<string, number>; // newest 30382 per d; rank 0–100 only
  export function weightOf(rank: number | undefined, line: number): number;               // 0 below line or undefined
  export async function resolveScorer(readers: (url: string) => RelayReader, signal: AbortSignal): Promise<Scorer | null>;
  export async function fetchRanks(reader: RelayReader, scorer: string, pubkeys: readonly string[], signal: AbortSignal): Promise<Map<string, number>>; // batches of 500 `#d`
  ```

- [ ] **Step 1: Write failing tests** with `tests/support/memoryReader.ts`:
  - `scorerFrom`: picks the newest 10040 by the house and ignores other authors; reads the first `30382:rank` tag; rejects a non-hex scorer or a non-ws relay.
  - `ranksFrom`: drops "abc", "-1", "101" and "" (Review Focus 1); keeps the newest per `d`.
  - `weightOf`:
    - `(undefined, 2)` → 0;
    - `(1, 2)` → 0;
    - `(2, 2)` → 0.02;
    - `(80, 2)` → 0.8.
  - `fetchRanks`: with 1,200 pubkeys it sends 3 requests (500, 500, 200), each with `authors: [scorer]`, `kinds: [30382]` and `#d`.
  - `resolveScorer`:
    - returns `config.devScorer` without any request when it is set;
    - returns null when no relay has a 10040;
    - returns null when the relay fails (Review Focus 4).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: the house's trust in reviewers`.

### Task 3: Score maths

**Files:**
- Create: `src/score/score.ts`, `tests/score.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PlaceScore { score: number | null; counted: number; outside: number; orderKey: number; inside: Review[]; folded: Review[] }
  export function scorePlace(reviews: readonly Review[], weight: (pubkey: string) => number, prior: { priorWeight: number; priorMean: number }): PlaceScore;
  export function formatScore(score: number): string; // one decimal, Latin digits: 4.5, 4.0
  ```

- [ ] **Step 1: Write failing tests.**
  - Weights 0.8 (5★) and 0.2 (3★) → score 4.6, counted 2.
  - A null-stars review inside the view is in `inside`, but it is not counted and does not enter the score.
  - Weight 0 → `folded`.
  - No reviews → score null, counted 0, outside 0, orderKey 3.5.
  - One 5★ at weight 1 orderKey = (5 + 5.25) / 2.5 = 4.1, which is below a 4.4 from five reviewers at weight 1.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: score a place from a point of view`.

### Task 4: Local relay proof

**Files:**
- Create: `tests/proof/houseScores.proof.ts`, `vitest.proof.config.ts`, `tests/proof/local.ts`, `tests/proofGuard.test.ts`
- Modify: `package.json` (`"proof:house-scores": "vitest run --config vitest.proof.config.ts"`), `README.md`

**Interfaces:**
- Consumes: Tasks 1–3: `readerFor`, `latestReviews`, `ranksFrom`, `scorerFrom`, `weightOf`, `scorePlace`, `formatScore`.
- Produces:
  ```ts
  export function assertLocal(url: string): void; // tests/proof/local.ts — throws unless the host is localhost, 127.0.0.1 or [::1]
  ```

The proof runs under Vitest, so TypeScript and `import.meta.env` work as in the app. It uses its own config:
- environment node;
- no WebSocket stub;
- includes only `tests/proof/*.proof.ts`.

The default `npm test` (and CI) never runs it, because it needs a local relay.

- [ ] **Step 1: Write the failing test.** `tests/proofGuard.test.ts`: `assertLocal` throws for `wss://dcosl.brainstorm.world`, `wss://scores.brainstorm.world` and `ws://10.0.0.1:7777`, and passes `ws://localhost:10547`, `ws://127.0.0.1:10547` and `ws://[::1]:10547`.
- [ ] **Step 2: Run** `npx vitest run tests/proofGuard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `assertLocal` and the proof.** The relay comes from `PROOF_RELAY` (default `ws://localhost:10547`, as `nak serve` starts it). `assertLocal` runs first.
  1. Generate throwaway keys with nostr-tools: a house H, a scorer S, and reviewers A, B, C and D.
  2. Publish (NRelay1 `event`, all signed with nostr-tools `finalizeEvent`):
     - H's kind 10040 naming S on the same relay;
     - S's kind 30382 ranks: A 80, B 30, C 1, D none;
     - the reviewers' kind 34259 reviews of two real place addresses from `tests/fixtures/funchal-items.json`. Place 1: A 5, B 3, C 1, D 4. Place 2: C 5.
     - B also reviews place 1 twice: the newer review gives 3, the older 1.
  3. Read everything back through `readerFor(relay)`: `scorerFrom` with house H, `ranksFrom`, `latestReviews`, `weightOf`, `scorePlace`.
  4. Assert:
     - **Scorer:** the resolved scorer is S.
     - **Place 1:** score (0.8×5 + 0.3×3) / 1.1, formatted "4.5"; counted 2; folded 2 (C below the line, D unscored); B counted once, with 3 stars.
     - **Place 2:** score null; folded 1.
  5. Never write a key to disk. Print the place results and "Proof passed". With `PROOF_KEEP=1`, also print `VITE_DEV_SCORER=<S hex>@<relay>` for a browser check.
- [ ] **Step 4: Run.**
  - `npx vitest run tests/proofGuard.test.ts` → PASS.
  - With `nak serve` running: `npm run proof:house-scores` → PASS.
  - With no relay running, the proof fails with a clear connection message, not a hang (the reader's connect timeout).
- [ ] **Step 5: Document.** Add a README section, "House scores, locally": `nak serve`, then `npm run proof:house-scores`.
- [ ] **Step 6: Commit** `feat: prove house scores on a local relay`.

---

## Waiting for Avi's review of this plan

Tasks 1–4 are decision-free and change nothing a visitor sees: pure modules, plus a proof against a local relay. Tasks 5–7 put scores on screen and add new copy and new network hosts, so they wait until Avi has read this plan.

### Task 5: The scores store

**Files:**
- Create: `src/score/ScoresProvider.tsx`, `src/score/useScore.ts`, `tests/scoresStore.test.tsx`
- Modify: `src/main.tsx` or `src/shell/Shell.tsx` (mount the provider inside PlacesProvider)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export function ScoresProvider(props: { children: ReactNode; readers?: (url: string) => RelayReader }): JSX.Element;
  export type HouseState = "idle" | "loading" | "ready" | "unavailable";
  export function useScores(addresses: readonly string[]): { scores: Map<string, PlaceScore>; house: HouseState };
  export function useScore(address: string): { score: PlaceScore | undefined; house: HouseState };
  ```

- [ ] **Step 1: Write failing tests**, with memory readers and fake timers:
  - **No relays:** with `reviewRelays: []`, mounting and asking for 50 addresses sends no request at all, and every score is undefined.
  - **Batching:** asking for 300 addresses sends review requests in batches of 100 `#d` (kinds [34259]). Addresses already fetched this session are not asked for again.
  - **Order of reads:** once reviews arrive, the 10040 is read once per session, then the ranks for the reviewers not yet known.
  - **Before the ranks arrive:** the place has `score: null` and every review is folded (Review Focus 3).
  - **Scorer down:** `house` is "unavailable", and reviews are still listed folded (Review Focus 4).
  - **Unmount:** in-flight requests abort.
  - **Refetch drops removed reviews:** after a session refetch (`refresh()`), a review the relay no longer returns is gone (Review Focus 2).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Requests are coalesced per animation frame (or a 50 ms debounce) across components.
  - Reviews come from every relay in `config.reviewRelays` and are merged with `latestReviews`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: reviews and house ranks for the places on screen`.

### Task 6: Scores on screen

**Files:**
- Modify:
  - `src/ui/PlaceCard.tsx`, `src/ui/PlaceRow.tsx`, `src/place/ScorePanel.tsx`, `src/place/PlacePage.tsx`;
  - `src/map/pins.ts`, `src/chain/ChainPage.tsx`;
  - `src/explore/*` and `src/search/*` (pass addresses to `useScores`);
  - `src/copy/en.ts`.
- Test: `tests/scoresUi.test.tsx`

**Interfaces:**
- Consumes: `useScores`, `useScore`, `formatScore`.

- [ ] **Step 1: Write failing tests** (the provider fed by memory readers):
  - **Card with `counted ≥ 1`:** the score at the top right (design Main.dc.html), and the who-line "Rated by 3 people the house trusts" (copy `score.ratedByHouse(n)`, DRAFT; one person: "Rated by 1 person the house trusts").
  - **`counted = 0` with other reviews:**
    - the dashed card with "No score yet", and "2 other people have rated it" (DRAFT);
    - only in a list where some card has a score, per M1's `unrated-dashed` rule.
  - **No reviews:** unchanged from M1.
  - **Pins:** `Pin.label` is the formatted score when counted ≥ 1, else absent (the ring).
  - **Place page, scored:**
    - the score panel shows the big number, `Stars`, and "From 3 people the house trusts";
    - the reviews inside the view are listed (stars, date, text; no names in this task: reviewer names need profiles, which is M2 step 5);
    - the fold "2 more from people outside the house's picks. Folded away, not removed." with "Show them" opening them dimmed (DRAFT).
  - **Place page, not scored:** M1's dashed "Be the first" panel, unchanged.
  - **Chain:** the nearby range "Near you, the house rates them from 3.6 to 4.4" when at least two nearby locations have scores; one → "Near you, the house rates one 4.2"; none → M1's line (DRAFT).
  - **House unavailable:** one quiet line under the score panel: "House picks can't be worked out right now." (DRAFT).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, matching the design files' score panel and card score slot (Place.dc.html, Main.dc.html).
- [ ] **Step 4: Run** the full suite plus `tests/copy.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: house scores on cards, pins and the place page`.

### Task 7: Controller check (after Tasks 5 and 6)

- [ ] Run `nak serve` and the proof with `PROOF_KEEP=1` (it prints its scorer), then the dev server with `VITE_REVIEW_RELAYS=ws://localhost:10547` and `VITE_DEV_SCORER=<that scorer>@ws://localhost:10547`.
- [ ] Open both places at 390 and 1360:
  - place 1 shows 4.5 from 2 people, with 2 folded;
  - place 2 shows "No score yet" with 1 folded;
  - the map pin for place 1 is a score pill.
- [ ] With no env set: no request to any new host (network panel), and everything is as in M1.

---

## Overnight record (2026-10-08)

Tasks 1–4 were built and reviewed task by task, then the branch had a final review. Verdict: ready to merge, with no Critical or Important findings. `npm test` gives 1,717 tests. With `nak serve --events tests/fixtures/forged-reviews.jsonl`, `npm run proof:house-scores` passes 4 of 4:
- Jacafé scores 4.5 from 2 people, with 2 folded;
- Loft has no score, with 1 folded;
- both forged reviews are dropped.

The production bundle is unchanged: none of the new modules are imported, and `reviewRelays` is `[]`.

A read-only check showed the real chain is in place. Mise en Place's kind 10040 is on wss://scores.brainstorm.world (and on damus, nos.lol, primal and purplepag.es). It names scorer `151466c4…` on that relay, which holds at least 5,000 ranks.

### Rulings made overnight
- **R1.** Scope tonight was Tasks 1–4: decision-free, nothing visible, nothing reaching production. They merge to main. Cost if wrong: unused modules on main.
- **R2.** Tasks 1–3 were built and reviewed as one unit.
- **R3a.** A 0–1 `rating` below 0.2 gives fractional stars under 1 (0.1 → 0.5). Only exactly 0 is null. Cost if wrong: one comparison.
- **R3b.** Signatures are checked for reviews, the house's 10040 and the scorer's 30382s: `readerFor(url, { verify = true })`. Only the places reader opts out, under M1 ruling R12. Cost if wrong: none; this is the safe side.
- **R3c.** Two UI tests (place-page, explore) are flaky under full-suite load. They predate M2a. A flake fails the deploy job safely, but it is a nuisance. This is a follow-up.
- **R4.** Review fix round:
  - one 64-hex check (`src/nostr/shapes.ts`);
  - `latestReviews` follows NIP-01 replacement per (pubkey, d) before grouping by place;
  - config is reset in one place in the tests;
  - abort and limit tests;
  - doc lines.

### Carry into Task 5 (from the final review)
- **Bundle split.** `readerFor` lives in the lazily loaded relay chunk (Nostrify, 65 KB gzip). `ScoresProvider` must not import it statically. Instead, give it a default `readers` that does a dynamic `import()` inside `req`.
- **Raw events.** Keep raw review events per address batch and re-run `latestReviews` over them. `Review` carries no `d`. `refresh()` replaces the batch; it does not merge into it (Review Focus 2).
- **One voice per person.** `scorePlace` counts each review it is given. Before merging reviews across filings of one place (brief §4.3), keep the newest per reviewer, inside `scorePlace` or before it, and pin that with a test.
- **"Unavailable".** `resolveScorer` returns null for both "no 10040" and "relays down", and `fetchRanks` throws on any failed batch; both mean "unavailable". The store must remember which pubkeys it has asked about, because unranked people are simply absent from the map.
- **Verification is the reader's job.** `scorerFrom`, `ranksFrom` and `latestReviews` assume their input came from a verifying reader. Never feed them from a cache without that.
- **Location.** Move the nostr primitives (`asEvent`, `isNewer`, `RelayReader`, `readerFor`) out of `src/places/` into `src/nostr/` at the start of Task 5, before new importers appear.

### Deferred minors
- the order-dependent config reset test pair;
- the proof's "B counted once" is really nak's replacement;
- no marker tag (`["t","regulars-proof"]`) on the proof's reviews and the forged fixture;
- README nits (run from the repo root; a `PROOF_RELAY` must hold the forged events), and the stale line in `tests/fixtures/README.md`;
- more guard-test cases;
- the proof's `hookTimeout` against the worst case;
- a contract test that a forged event is dropped by the real `NRelay1.receive`.
