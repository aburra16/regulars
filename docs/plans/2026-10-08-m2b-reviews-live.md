# M2b Reviews Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can sign in, rate a place (1–5 stars plus optional words), edit their review or remove it, and see House picks scores worked out from the reviewers Mise en Place trusts. This covers brief §13 steps 3 (on screen) and 4, plus the part of step 5 needed to post.

**Architecture:**
- **Reviews:**
  - stored as kind 34259 on `wss://search.brainstorm.world` (read with `search: "include:spam"`) and on the reviewer's own write relays;
  - read per place address with `#a`;
  - scored in the browser with the M2a engine.
- **Sign-in:** signs with a browser extension (NIP-07, Nostrify `NBrowserSigner`) or a signer app on a phone (NIP-46, Nostrify `NConnectSigner`). The person's key never reaches the app.
- **Out of scope here:**
  - My circle (the Brainstorm calculation, the consent question);
  - the Trust button;
  - "Helpful";
  - tags;
  - saved lists.

**Tech Stack:** as M1/M2a. Nostrify signers (`NBrowserSigner`, `NConnectSigner`, `NSecSigner` for the app's own connection key) and nostr-tools helpers. No hand-written crypto.

**Spec:**
- handoff/REGULARS_APP_BRIEF.md §4, §5, §9, §10 (screens 6, 7, 8, 10; D2, D3, D6);
- docs/decisions.md;
- docs/plans/2026-10-08-m2a-house-scores.md (Tasks 5–6 are folded in here; see its "Carry into Task 5" notes);
- Avi on 2026-10-08:
  - reviews on search.brainstorm.world plus own relays, with `d = place:<address>`;
  - the line at rank 5;
  - signer apps on phones.

## Global Constraints

- **Review event:**
  - **Kind:** 34259.
  - **`d`:** `place:39999:<filer>:<d>`.
  - **`a`:** the place address.
  - **`m`:** `place`.
  - **Rating:** `rating` = stars ÷ 5 to 3 decimals, plus `s` = whole stars 1–5.
  - **`alt`:** `Review of <name>: <n> of 5 stars`.
  - **Text:** in `content`; empty is allowed.
  - **Reading:** accept `a` = place address, or `d` = place address with or without the `place:` prefix.
- **Review relays:**
  - production `config.reviewRelays = ["wss://search.brainstorm.world"]`;
  - reads to that relay carry `search: "include:spam"`, sent to that relay only (another NIP-50 relay would take it as words to search for).
- **Line:** `config.scoring.line = 5`. Weight = rank/100 at rank ≥ 5, otherwise 0. No rank means outside.
- **No numbers on people (Avi, 2026-10-08).**
  - A place shows its rating (e.g. "4.5 ★, rated by 3 people the house trusts").
  - A person never shows a trust number, rank, weight or meter anywhere. Ranks only decide whose reviews count.
  - Reviewers appear by name only.
  - The folded section must not read as a verdict on the people in it. DRAFT wording: "4 more reviews from outside House picks. Shown on request, never removed."
- **Scores:**
  - computed at read time;
  - never stored;
  - toggling views refetches nothing;
  - one voice per reviewer per place, the newest review winning.
- **Keys:**
  - no private key of the person is ever in the app;
  - the app's own NIP-46 connection key lives in `sessionStorage` (cleared when the tab closes) and never in a URL or log.
- **Removal:** a NIP-09 kind 5 with both `e` (the review's id) and `a` (`34259:<pubkey>:<d>`), sent to every relay the review went to. The app hides the review at once.
- **Words:**
  - every visible string goes in `src/copy/en.ts`;
  - banned: npub, relay, event, key, sign (except "Sign in" / "Sign out" / "signed in", ruling R7), follow, zap, DList, GrapeRank, web of trust, kind numbers;
  - "Nostr" appears only on Continue with Nostr;
  - new strings are marked `// DRAFT for Avi`.
- **New network hosts:**
  - `wss://search.brainstorm.world` (reviews, reviewer names);
  - `wss://scores.brainstorm.world` (the house's scorer, read from its kind 10040);
  - `wss://purplepag.es` (the reviewer's relay list, read only when posting or removing; ruling R6);
  - the reviewer's own write relays, only when posting or removing;
  - one NIP-46 meeting point, `wss://relay.nsec.app` (or the relay a bunker link names), only while connecting a phone app and asking it to sign.
- **Tests:** they wait for outcomes (`waitFor`/`findBy`) and never assert wall-clock time. CI deploys only on green.

## Review Focus

1. **A review posted, then the page reloaded before the relay answers a read:** the person's own review still shows (the optimistic copy is held until the relay returns it or the post fails). Test in Task 6.
2. **The person removes a review and a lagging relay still serves it:** it stays hidden for that person. Other viewers see it until their relays drop it. Test in Task 7.
3. **A phone signer app that never answers, or is closed half-way:** sign-in shows a clear "didn't connect" with Try again, and nothing hangs. Test in Task 4.
4. **A reviewer with no name (no kind 0):** shows as "Someone" (DRAFT), never a code or a key. Test in Task 3.
5. **The house's scorer cannot be read:** reviews still list (folded), with one quiet line. No score from unweighted stars. Test in Task 3.

---

### Task 1: Review format, line 5, and the nostr toolkit in one place

**Files:**
- Create: `src/nostr/` (move `asEvent`, `isNewer`, the `RelayReader` type and `readerFor` here from `src/places/`); `src/reviews/write.ts`
- Modify: `src/reviews/review.ts`, `src/config.ts`, `src/places/load.ts`, `src/places/relayReader.ts` (re-export or update imports)
- Test: `tests/review.test.ts`, `tests/reviewWrite.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function reviewTemplate(place: Place, stars: 1|2|3|4|5, text: string, now: number): EventTemplate; // src/reviews/write.ts
  export function removalTemplate(review: { id: string; pubkey: string; d: string }, now: number): EventTemplate;
  config.reviewRelays: string[];                // production ["wss://search.brainstorm.world"]
  config.relayReadExtras: Record<string, { search?: string }>; // { "wss://search.brainstorm.world": { search: "include:spam" } }
  config.scoring.line: 5;
  ```
- [ ] **Step 1: Write failing tests.**
  - **`reviewTemplate` (Jacafé, 4, "Get the bolo")** has tags `d` = `place:39999:4bded…:osm-node-11330857543`, `a` = the address, `m` = `place`, `rating` = `0.800`, `s` = `4`, `alt` = `Review of Jacafé: 4 of 5 stars`; content "Get the bolo"; kind 34259.
  - **`parseReview`** reads it back. It also reads a bare-address `d` with no `a`, and a `place:`-prefixed `d` with no `a`.
  - **`removalTemplate`** has kind 5 with `["e", id]`, `["a", "34259:<pk>:place:39999:…"]` and `["k","34259"]`.
  - **`config`:** the production `reviewRelays` is the search relay; `scoring.line` is 5; `weightOf(4, 5)` is 0 and `weightOf(5, 5)` is 0.05.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Move the primitives; their behaviour is unchanged and the existing tests pass with updated imports.
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the review format, rank 5, and one home for the nostr toolkit`.

### Task 2: The scores store (M2a Task 5, adjusted)

**Files:**
- Create: `src/score/ScoresProvider.tsx`, `src/score/useScore.ts`, `src/nostr/profiles.ts`
- Modify: `src/main.tsx` or `src/shell/Shell.tsx`
- Test: `tests/scoresStore.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function ScoresProvider(props: { children: ReactNode; readers?: (url: string) => RelayReader }): JSX.Element;
  export type HouseState = "idle" | "loading" | "ready" | "unavailable";
  export function useScores(addresses: readonly string[]): { scores: Map<string, PlaceScore>; house: HouseState };
  export function useScore(address: string): { score: PlaceScore | undefined; reviews: Review[]; house: HouseState };
  export function useNames(pubkeys: readonly string[]): Map<string, string>; // display_name ?? name, from kind 0 on the review relays
  ```
- [ ] **Step 1: Write failing tests** (memory readers):
  - **M2a Task 5's tests:**
    - no relays means no request;
    - reviews are batched (100 addresses per request) by `#a` (not `#d`), with `search: "include:spam"` only on the search relay;
    - the 10040 is read once and the ranks are fetched for unknown reviewers;
    - with no ranks yet, all reviews are folded;
    - a scorer that is down gives "unavailable";
    - requests abort on unmount;
    - `refresh()` replaces the batch.
  - **One voice:** two filings of one place (same `osm-id`) count the same reviewer once, the newest winning.
  - **Lazy:** the store does not import the relay chunk until it has addresses (dynamic `import()`).
  - **Names:** `useNames` asks for kind 0 once per pubkey, batches requests and falls back to "Someone".
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: reviews and house ranks for the places on screen`.

### Task 3: Scores and reviews on screen (M2a Task 6)

**Files:**
- Modify:
  - `src/ui/PlaceCard.tsx`, `src/ui/PlaceRow.tsx`, `src/map/pins.ts`, `src/chain/ChainPage.tsx`;
  - `src/place/ScorePanel.tsx`, `src/place/PlacePage.tsx`, plus a new `src/place/Reviews.tsx`;
  - `src/explore/*`, `src/search/*`;
  - `src/copy/en.ts`.
- Test: `tests/scoresUi.test.tsx`

- [ ] **Step 1: Write failing tests.** Everything in M2a Task 6, with these changes:
  - **Review list:** the place page lists the reviews inside the view. Each one has the reviewer's name (`useNames`), stars, date and text, in the design's review layout (Place.dc.html, "From your circle", worded for the house: "Rated by people the house trusts", DRAFT).
  - **Folded reviews:** "N more reviews from outside House picks. Shown on request, never removed." with "Show them" (DRAFT). They are shown dimmed, never labelled with any rank or number.
  - **No numbers on people:** a test renders a place with ranked reviewers and asserts that no rank, weight or percentage appears anywhere in the page text or in accessible names.
  - **Sorting:** with scores present and no sort chosen, the Explore list keeps distance order. A new sort choice, "House picks' score", uses `orderKey`; it is enabled signed out, replacing the disabled "My circle's score" in M2b.
  - **Review Focus 4:** a reviewer with no name shows as "Someone".
  - **Review Focus 5:** when the scorer is unavailable, the reviews are folded and the quiet line shows.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, matching Place.dc.html, Main.dc.html and DeskPlace.dc.html.
- [ ] **Step 4: Run** the full suite, including the copy gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat: house scores and reviews on screen`.

### Task 4: Sign in to post

**Files:**
- Create: `src/account/AccountProvider.tsx`, `src/account/connect.ts` (NIP-46 nostrconnect and bunker), `src/signin/ChooseHow.tsx`
- Modify: `src/signin/SignInPage.tsx`, `src/shell/TopBar.tsx`, `src/you/*`, `src/config.ts` (`features.signIn: true`, `connectRelay: "wss://relay.nsec.app"`), `src/copy/en.ts`
- Test: `tests/account.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type Account = { pubkey: string; signer: NostrSigner; how: "browser" | "phone" };
  export function useAccount(): { account: Account | undefined; signOut(): void; restoring: boolean };
  export async function connectPhone(opts: { onLink(uri: string): void; signal: AbortSignal }): Promise<Account>; // nostrconnect:// shown as a QR and a copyable link
  export async function connectBunker(uri: string, signal: AbortSignal): Promise<Account>;  // pasted bunker:// link
  ```
- [ ] **Step 1: Write failing tests:**
  - **Choices:**
    - Continue with Nostr opens the choice between "This browser" and "An app on your phone" (DRAFT words; no banned word);
    - "This browser" is offered only when `window.nostr` exists;
    - otherwise a line says how to get one (DRAFT).
  - **Phone connection:**
    - the phone path shows a QR and a copyable link `nostrconnect://<app pk>?relay=wss%3A%2F%2Frelay.nsec.app&secret=<random>&name=Regulars`;
    - it accepts the signer's `connect` reply only with the matching secret;
    - a reply with a wrong secret is ignored.
  - **Review Focus 3:** with no answer within 120 s (fake timers), or when cancelled, it shows "That didn't connect. Try again." (DRAFT). There is no hang and no leftover subscription.
  - **Session:**
    - the app's connection key goes to `sessionStorage`, never to `localStorage`, a URL or the console;
    - a reload in the same tab restores a phone session with no new scan;
    - "browser" restores by asking `window.nostr.getPublicKey()` again.
  - **Signed-in chrome:**
    - the top bar's account button shows the person's name (kind 0, or "You");
    - `/you` shows the name and Sign out;
    - Sign out forgets the session.
  - **Still disabled:** My circle stays disabled ("soon"), and the sign-in page's notice stays.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with Nostrify `NBrowserSigner`, `NConnectSigner` and `NSecSigner`, plus nostr-tools `generateSecretKey`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: sign in with this browser or an app on your phone`.

### Task 5: Where a person's reviews go

**Files:**
- Create: `src/account/writeRelays.ts`
- Test: `tests/writeRelays.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function writeRelaysOf(pubkey: string, signer: NostrSigner, readers: (url: string) => RelayReader, signal: AbortSignal): Promise<string[]>;
  ```
- [ ] **Step 1: Write failing tests.**
  - **Sources, in order:**
    1. the person's newest kind 10002 `w` / unmarked `r` entries from `config.reviewRelays` and `wss://purplepag.es`;
    2. if there are none, `signer.getRelays?.()` write entries.
  - **Merging:** always merged with `config.reviewRelays`, de-duplicated, at most 6.
  - **Bad URLs:** only `wss://` URLs are kept; any non-wss scheme or private address (localhost, 10.x, 192.168.x) is dropped.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: send a review where its author publishes`.

### Task 6: Write a review (screen 8, D3)

**Files:**
- Create: `src/review/ReviewForm.tsx`, `src/review/ReviewPage.tsx` (phone), `src/review/ReviewDialog.tsx` (desktop), `src/review/post.ts`
- Modify: `src/place/ScorePanel.tsx` (`RateButton` goes to the form when signed in), `src/routes.tsx` (`/place/:d/review`), `src/score/ScoresProvider.tsx` (optimistic own review), `src/copy/en.ts`
- Test: `tests/reviewForm.test.tsx`, `tests/post.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function postReview(template: EventTemplate, signer: NostrSigner, relays: string[], signal: AbortSignal): Promise<{ event: NostrEvent; accepted: string[]; refused: Record<string, string> }>;
  ```
- [ ] **Step 1: Write failing tests.**
  - **The form** (Review.dc.html, DeskReview.dc.html):
    - five 44 px star buttons, each with a word (design words);
    - an optional text box, "What should a friend know?";
    - the notice "Reviews are public and carry your name. One review per place: posting again replaces this one.";
    - Post stays off until a star is chosen;
    - an existing own review pre-fills the form.
  - **Posting:**
    - Post signs `reviewTemplate` with the account's signer and publishes to `writeRelaysOf`;
    - success needs at least one accepting relay, with the review relay preferred;
    - when all refuse, it shows "Your review didn't post. Try again." with what was typed kept (DRAFT).
  - **Review Focus 1:** the own review shows at once (optimistic) and survives a reload until a read returns it.
  - **Signed out:** Rate this place goes to sign-in and comes back to the form.
  - **Desktop:** the form is a dialog over the place page, with focus trapped and returned.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Tags stay behind the off switch (brief §4.4).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: rate a place`.

### Task 7: Remove a review

**Files:**
- Modify: `src/place/Reviews.tsx` (own review: Edit, Remove), `src/review/post.ts` (`removeReview`), `src/score/ScoresProvider.tsx`, `src/copy/en.ts`
- Test: `tests/removeReview.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - **Confirming:** Remove asks to confirm (DRAFT: "Remove your review? It comes off Regulars and the places it was sent to.").
  - **Publishing:** it signs `removalTemplate` and publishes it to the same relays.
  - **Hiding:** the review is hidden at once. It stays hidden for this person if a lagging relay serves it again: the store keeps the removed address with the removal's `created_at` and ignores older copies (Review Focus 2).
  - **Re-rating:** rating again after a removal posts a newer review, which shows.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: remove a review`.

### Task 8: Live check (controller, with Avi)

- [ ] **Deploy.** The sign-in notice and DRAFT strings are listed for Avi.
- [ ] **Avi posts the first real review** of a Funchal place, from his phone app and then from a browser extension.
  - A plain read of the search relay returns it (`{"kinds":[34259],"#a":[<address>],"search":"include:spam"}`).
  - Posting again replaces it.
  - Brainstorm-UI's review page shows it.
- [ ] **Scoring.** If Avi's rank from the house scorer is 5 or more, the place shows a House picks score; otherwise the review is listed, folded.
- [ ] **Removal.** Removing it makes a plain read return nothing.
- [ ] **No test data** goes to any public relay at any point.

---

## Build record (2026-10-08)

Tasks 1–7 were built and reviewed task by task, then the whole branch was reviewed and had one fix wave. Verdict: ready to merge. `npm test` runs 2,366 tests. The production build reaches only the allowed hosts. Task 8 (the live check with Avi) follows the merge.

### Rulings made during the build

**Store and reading**
- **R1.** The store exposes `noteOwnReview` and `noteRemoval` for posting and removal.
- **R2.** Every relay reader stays behind a dynamic import, so Nostrify stays out of the entry chunk. A build-based test guards this.
- **R3.** Read extras (`include:spam`) are merged per relay. `Review` carries its own `d`. One voice per reviewer per place, across filings.
- **R4.** A place has no score while any of its reviewers' ranks is still being read, so nobody is shown as "outside" before we know. Scores keep their identity when nothing changed. Reads by `#a` and `#d`. A 50 ms request window. Names lose only the characters that can reorder text; joiners stay.

**Order of work**
- **R5.** Order of work: Task 5 first, then Tasks 3 and 4 in parallel, after dark mode merged (R8).

**Where reviews go**
- **R6.** purplepag.es is read for a person's relay list when they post. config.reviewRelays is trusted. Strict filtering of private hosts.
- **R7.** The trailing-dot bypass is closed. The address checks run on the final address. `config.relayListRelays`.

**Scores on screen**
- **R9 and R10.**
  - **Read state:** each place's read state is shown honestly: nothing while reading, a quiet line on failure, Try again.
  - **Sort:** the House picks sort puts scored places first, then the rest by distance.
  - **Cards:** memoised.
  - **Reads:** at most 2 batches in flight per relay.

**Sign-in**
- **R11.**
  - **Account button:** keeps the design's initial, with an accessible name of "<name>, your account".
  - **Phone apps:** they may answer with NIP-04 or NIP-44.
  - **On a phone:** "Open the app".
  - **Already signed in:** visiting /signin goes back where you came from.
  - **AccountChanged:** a typed error.

**Posting and removing**
- **R12–R14.**
  - A review counts as posted only when a review relay accepts it. Otherwise: "Saved to your own places, but not to Regulars yet. Try again."
  - Relays are written in parallel under one bound.
  - Try again resends the same signed review. It doesn't sign again.
  - The held own review is tied to the account and forgotten at sign-out.
  - The stars are a radio group, overriding the design's pressed buttons.
  - The signed event is checked against its template.
  - `created_at` is later than the person's previous review or removal.
- **R15–R17.**
  - "Your review" sits at the top of the place's reviews, with Edit and Remove. "You've rated it" replaces counting yourself among "others", on the panel and on cards.
  - Removal covers every one of the person's reviews of the place, sent to every relay each was sent to.
  - In the confirm, "Keep it" sits where Remove was, and Escape keeps the review.
  - A partial removal is said honestly.
  - Signer-appended tags may not reuse the template's tag names, nor `d`, `a`, `e`, `k`, `p`, `expiration`, `-` or `delegation`.
  - Accepted: a lone reviewer can infer whether the house counts them. It is a yes or no, never a number.

**Final fix wave**
- **R18.** It covered:
  - a flaky test;
  - phone app permissions cut to `get_public_key` and `sign_event:34259`, so removals ask each time;
  - the house view recovers from a failed rank read (retry when back on line, Try again, a rank lane);
  - review reads page back past spam, including a one-second flood;
  - future-dated reviews are dropped;
  - a draft survives a phone rotation;
  - a 60 s limit on browser signing;
  - the docs.

  Not taken: a Content-Security-Policy meta tag (not in the spec; a hardening for Avi to consider), and rare IPv6 transition ranges.

### Deferred minors

**Sign-in**
- A no-"from" sign-in lands on /you (accepted).
- "Open the app" is chosen by layout width, not device.

**Scores and lists**
- Cards redraw once when the house goes from loading to ready.
- A targeted retry of failed places, not a full refresh.
- Places whose later rank read failed wait for the next try.

**Code and tests**
- `Posted.accepted`/`refused`/`settled` are unused outside tests.
- The empty focus target after removing your only review has no accessible name.
- Names still being read can be queued twice after a refresh (harmless).

**Address filtering:** SIIT, Teredo and `192.0.0.0/24` addresses are not filtered (not routable from a browser).
