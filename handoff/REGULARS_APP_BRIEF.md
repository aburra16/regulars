# Build brief — a food-review app on the Food and Drink Places DList

**Name:** Regulars (decided by Avi, 2026-10-07). **Domain:** `askregulars.world`, registered by Avi at Namecheap; he will host it. Keep the name and the domain in one config file.
**Status:** 🔴 OPEN — nothing is built.
**For:** Claude Code, in a **new repository of its own** (not the Tapestry checkout, not the importer).
**From:** a Claude desktop session with Avi, 2026-10-07. You have none of that conversation; this file carries it.
**Owner of every decision here:** Avi. Where this says "ask Avi", stop and ask.
**Revision 4, 2026-10-07.** Name and domain settled; desktop layouts added to § 10; this file now travels in a handoff folder (see `START_HERE.md` beside it). Revision 3 brought it into line with the complete "Food and Drink Places: reference app design brief" (the copy with "The social layer" and "Trust in the interface"). The review format in § 4 changed: reviews are now kind 34259, not items of a second DList.
**Companion files:**

- Avi's design brief, `food-and-drink-design-brief.md`. Read it first. It holds the fill rates, the catalogue counts, the social-layer table and eight open decisions. Where it and this file differ on the state of the data, it wins; it was written from the build.
- The screens: fifteen phone screens and six desktop pages, in `design/` beside this file (`design/SCREENS.md` is the index). They come from Avi's design canvas "Regulars — food app screens", which you cannot open. § 10 describes each one.
- `BTCMAP_FOOD_DLIST_HANDOFF.md`: how the list was made. Its § 2 is the reading list for the protocol, Dictionary and Opinionated Views context.
- The importer, [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place): working code for reading the list.

How to read the claims below:

- **Verified** — read from a repository or seen in a live response on 2026-10-05 to 07.
- **Assumed** — a reasoned choice nobody has tested. Test before relying on it.

---

## 1. What this is

A reference app that shows what the DList stack is for: **a restaurant-review app where ratings come from people you trust.** To a visitor it is simply a better Yelp. It must work for someone who has never heard of the technology underneath.

Three things define it:

1. **House picks** — the default view for everyone, signed in or not. Scores are worked out from the reviewers that the **Mise en Place** account trusts.
2. **My circle** — after sign-in, scores are worked out from the reviewers *this person* trusts. Brainstorm calculates this in the background.
3. **A toggle** between the two, available everywhere a score is shown.

**Not in the first version:** photo uploads, proof of a visit, tipping, owner responses, notifications, native apps.

---

## 2. Product rules (Avi's, not negotiable without him)

- **The words "Nostr" and "Bitcoin" appear in exactly two places.** The sign-in button ("Continue with Nostr") and a small "Bitcoin accepted" chip on a place's page. Nowhere else: not in headings, help text, empty states, error messages, the footer, page titles or metadata.
- **The bitcoin chip is on the place page only**, in the payment row. Never on cards, map pins, search results or filters. Avi confirmed this over the design brief's "small consistent badge" suggestion. Show it only when the item carries `accepts-bitcoin`; a place someone adds later may not.
- **No protocol vocabulary in the interface.** No "npub", "relay", "event", "web of trust", "zap", "DList", "GrapeRank", "follow" (say "trust"), "key", "sign" (say "sign in" / "post"), and no kind numbers. This holds on the "Why you see what you see" and "About" screens too; § 10 has the plain wording.
- **Plain names for the two views:** "House picks" and "My circle". The house curator may be named as "Mise en Place, our house curator".
- **OpenStreetMap attribution is required** wherever place details or a map are shown: "© OpenStreetMap contributors" on every map, and a "Place details © OpenStreetMap contributors" line on place, search and chain screens.
- **One open point for Avi:** the About screen credits the data source as "OpenStreetMap, gathered for us by BTC Map". That is the correct credit, and it puts "BTC" on one more screen. It is drawn that way; he may prefer to drop the BTC Map name from the interface and keep it in the repository's README.
- **Errors are written for a diner**, not a developer: "We couldn't load reviews. Try again." Never a relay URL or a status code.

---

## 3. What already exists (verified)

### 3.1 The places

- **7,954 places are live** (full import 2026-10-05, verified clean on both relays), across 115 countries; 43% are in the US.
- **Two relays:** `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`. The search relay refuses a plain read (`auth-required`); reads need the search field `include:spam`, and full-text queries need a signed-in web-of-trust observer.
- **Header:** `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places`, signed by Avi's own key.
- **Items:** kind 39999, signed by the Mise en Place account, pubkey `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64` (`npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8`).
- A real item, as returned by the relay:

  ```json
  ["d","osm-way-993221389"],
  ["z","39998:b83a28b7…:food-and-drink-places"],
  ["name","Smashny Burger"], ["category","fast_food"],
  ["address","42 Dobra Warszawa"], ["locality","Warszawa"], ["country","PL"],
  ["cuisine","burger"], ["osm-id","way:993221389"],
  ["lat","52.24068305"], ["lon","21.028061899999997"],
  ["website","https://smashnyburger.pl"], ["phone","+48 603 039 305"],
  ["opening-hours","Mo-Th 12:00-22:00; Fr 12:00-23:00; Sa 11:00-23:00; Su 11:00-22:00"],
  ["accepts-bitcoin","lightning"], ["btcmap-id","32645"],
  ["source","btcmap"], ["license","ODbL-1.0"],
  ["g","u3qcnw0hj"], ["g","u3qcnw"], ["g","u3qcn"], ["g","u3qc"],
  ["t","fast food"], ["t","burger"], ["t","warszawa"],
  ["alt","Food and drink place: Smashny Burger, Warszawa"]
  ```

- Useful for queries: **`g`** carries the geohash at 9, 6, 5 and 4 characters; **`t`** carries category, cuisine and city in lower case. Both are relay-indexed.
- **Fill rates are in the design brief; design every slot for them.** Name, category, coordinates, country and the bitcoin field are always present; address 85%, city 79%, hours 73%, phone 67%, website 58%, cuisine 52%, description 6%, **image 0.5%**. There is no neighbourhood, price, rating or photo set.
- **29 kinds of place in ten families** (the design brief's catalogue table). `category` and `cuisine` arrive as raw OpenStreetMap values (`fast_food`, `coffee_shop`); the app maps them to labels and icons, with a title-cased fallback.
- **Hours are OpenStreetMap syntax** and need a parser plus the place's own time zone (derive it from the coordinates) for "open now". Show the raw text when it will not parse, and "Hours not listed" when absent.
- **Chains repeat:** 356 names occur more than once; one has 317 locations. Lists and maps group them.
- **The list refreshes monthly.** A changed place keeps its address and gets a new event id. A closed place is deleted from the relays, so a saved or reviewed place needs a "No longer listed" state.
- **Anyone can file a place under this header.** Decide whose items count by trust, and treat two filings with the same `osm-id` as one place ("also listed by"), never as duplicate cards. Do not merge by name; that would fold every location of a chain into one.

### 3.2 The house view's scores

- The Mise en Place account has published a kind 10040 naming its scorer:

  ```json
  ["30382:rank","151466c4fd6ffbd64b36559465162095d9c94e1906f894d3c4d63c1378bd796a","wss://scores.brainstorm.world"]
  ```

- That scorer publishes one kind 30382 event per person it has scored. A real one:

  ```json
  {"kind":30382,"pubkey":"151466c4…","tags":[["d","<subject pubkey>"],["rank","6"],["followers","9"],["reporters","0"],["muters","0"],["hops","4"]]}
  ```

- So **"how much does the house trust reviewer R"** is one relay read: `{"kinds":[30382],"authors":["151466c4…"],"#d":["<R>"]}` on `wss://scores.brainstorm.world`. `rank` runs 0–100. No sign-in or API is needed.
- **Resolve the scorer by following the chain at run time** (house pubkey → its 10040 → scorer and relay). Do not hardcode `151466c4…`; Avi can re-point it.
- **House picks is Mise en Place's view, not Brainstorm's.** The design brief says a signed-out viewer gets Brainstorm.world's house scorer (published at `/.well-known/nostr.json?name=_`). Avi's instruction for this app was "the default house view (the mise en place npub)". This brief follows Avi's instruction. Confirm with him if in doubt; the two differ only in which account's 10040 you start from.
- The house's scores flow outward from **who Mise en Place follows** — three accounts on 2026-10-05. That follow list is the editorial lever for House picks. It is Avi's to manage, not the app's.

### 3.3 Brainstorm's API (`NosFabrica/brainstorm_server`, read at commit `dc8c4f3`)

Find the base URL in Brainstorm-UI's runtime config (`getBrainstormApi()` in `client/src/services/api/core`); do not guess it.

| Call | Purpose | Notes |
|---|---|---|
| `GET /authChallenge/{pubkey}` | get a challenge string | |
| `POST /authChallenge/{pubkey}/verify` with `{signed_event}` | exchange a signed event for a session token | Read `app/routers/auth_challenge/router.py` for the exact event the server expects. Brainstorm-UI's sign-in code is the working example. |
| `POST /user/graperank` (token) | start a score calculation for the signed-in person | Asynchronous. Rate-limited, with a per-account quota: expect `429` (quota) and `403` ("too recent"). |
| `GET /user/graperankResult` (token) | latest calculation and its state | Poll this. |
| `POST /user/trustSignals` with `{pubkeys:[…]}` | `influence` (0–1 or null), `verified`, `flagged` for up to **500** pubkeys | With a token: from that person's point of view. **Without a token: from Brainstorm's own default observer, which is not Mise en Place.** |

- The server allows browser requests from any origin (`allow_origins=["*"]`, no credentials), so a separate site can call it directly with a bearer token.
- **Do not use the unauthenticated `trustSignals` for House picks** (§ 3.2).

### 3.4 Relay constraints

- **`wss://dcosl.brainstorm.world` accepts list kinds and kind 7 only.** It turned away comments (kind 1111) with `blocked: not a supported Decentralized Lists event kind`. Assume it will turn away kind 34259 reviews too, until tested.
- **Relays cap how many events one request returns.** Brainstorm's own Dictionary reads at most 500 items per list. The importer pages by each relay's advertised limit; its `src/relay.ts` is a working example, including the `include:spam` read on the search relay.

---

## 4. Reviews — stars and words, on the format Brainstorm already shows

**Decided by Avi, 2026-10-07: a review is 1 to 5 stars plus optional written text.** The design brief also offered trust-weighted likes with comments and tags; he chose stars and kept two ideas from the other option: every score shows the people behind it, and tags sit beside the stars.

**The format is kind 34259** from `nostr-protocol/nips` PR #1914 ("Add A Generic Rating/Review NIP"). The PR is **open, not merged**. It is used here because Brainstorm-UI already reads and displays it, so the app adds no new format. This replaces the earlier proposal in this brief (reviews as items of a second DList), which is dropped.

No Tapestry convention for reviews exists yet, so this app sets it. **Tell Avi before the first review is published to a public relay**, so David and Vinney can object to the choice of kind.

### 4.1 The review event

```json
{ "kind": 34259,
  "content": "Get the grilled oysters and sit at the bar.",
  "tags": [
    ["d", "39999:4bded217…:osm-way-993221389"],
    ["a", "39999:4bded217…:osm-way-993221389"],
    ["m", "place"],
    ["rating", "0.800"],
    ["s", "4"],
    ["alt", "Review of Smashny Burger: 4 of 5 stars"]
  ] }
```

- **`d` is the place's address**, `39999:<filer>:<d>`. The kind is addressable, so each person has one live review per place and posting again replaces it. Use the address, never the event id; the event id changes at every monthly refresh.
- **`a` repeats the address.** Brainstorm-UI's review page reads `a` to find and title the rated thing (`useRatedSubject` in `client/src/components/share/things/ReviewPage.tsx`).
- **`m` is `place`.** Brainstorm-UI shows that as "Rating of a place" (`MARK_NOUNS` in `client/src/lib/thing.ts`).
- **`rating` is the PR's scale: a fraction from 0 to 1**, written to three decimals. Stars ÷ 5.
- **`s` is the whole star count, 1 to 5.** Brainstorm-UI's `starsOf` reads `s` first, then `rating`.
- **Reading other people's events:** copy `starsOf`. An `s` of 1–5 wins; else a `rating` of 0–1 is a fraction; else a `rating` of 1–5 is raw stars; else the review shows its text with no stars and does not enter a score.
- Text lives in `content`. Empty content is a rating-only review and is valid.
- **Queries:** reviews of places on screen `{"kinds":[34259],"#d":[<address>, <address>, …]}`; one person's reviews add `authors`.
- **Removal:** a NIP-09 deletion request for `34259:<reviewer>:<d>`.

### 4.2 Check before building on it

- **The `d` shape (Assumed).** The PR text says `d` is `<entity-type>:<id>` and that the type is whatever precedes the first colon. Brainstorm-UI's own test uses a bare address (`30040:x:y`) as `d` with `m` naming the type. For an address these disagree. Find what the existing publisher writes for an addressable subject (Brainstorm-UI's comments name Amethyst's Quartz `EntityRatingEvent`) and match it exactly.
- **Where reviews are stored (Open).** Probably not dcosl (§ 3.4). Find which relays Brainstorm-UI reads its `reviews` tab from (`client/src/services/search.ts` lists 34259 there), and ask Avi whether the team will accept 34259 on a NosFabrica relay. Publish to that plus the reviewer's own write relays.
- **Deletion.** Confirm the chosen relay honours deletion requests.
- **Publish nothing to a production relay while testing.** Use a local relay and throwaway keys.

### 4.3 One place, several filings

A review points at one filer's address. If two people file the same place (same `osm-id`), fetch reviews for every address that shares it and merge them, one voice per person, newest wins.

### 4.4 The rest of the social layer

| Piece | How | State |
|---|---|---|
| Tags ("Sit at the bar", "Good for groups") | Tapestry event taggings (`protocols/drafts/event-taggings.md`): one ±1 stance per person, tag and place | **Blocked.** Worksheet item W20: one person tagging two places by the same author keeps only the last, and all 7,954 places share one author. Build the tags row behind a switch and leave it off until the fix from `feat/tags` is in. |
| "Helpful" on a review | NIP-25 kind 7 `+`, pointing at the review's address (`a` = `34259:<reviewer>:<d>`) with a `p` for the reviewer | Counted with the same trust weights as reviews. dcosl accepts kind 7. |
| Saved places and lists | Personal DLists; entries are curation copies that point back at the original with `q` tags (design brief) | Lists are public. The screen says so. |
| Add a missing place | A kind 39999 item under the same header, signed by the person; `name` and `category` required | Shown to viewers who trust the filer. Check for a duplicate first: same kind, similar name, within about 50 metres. |
| Fix a listed place | A link to the place on OpenStreetMap | The fix arrives at the next monthly refresh. |
| Photos, proof of a visit, tips | — | Not in the first version. |

**What a reviewer gets back** (the design brief's sixth decision), as drawn: a page of their own with their reviews, a count of people who found them helpful, and lists other people can save.

---

## 5. Scoring — the heart of the app

**Rule zero, from the Tapestry repo's invariants: there is no "the rating". There is a rating from a point of view.** Never store a per-viewer score. Store raw reviews; compute at read time from `reviews × that viewer's trust in each reviewer`.

For a place and a point of view P:

```
weight(reviewer) = P's trust in that reviewer, 0 to 1; 0 if they are below P's line
score            = Σ weight × stars  /  Σ weight          (over reviewers with weight > 0)
counted          = number of reviewers with weight > 0
```

- **Where the weight comes from:**
  - House picks: `rank / 100` from the kind 30382 events of Mise en Place's scorer (§ 3.2).
  - My circle: if the person has their own kind 10040, read ranks from the scorer it names, the same way. If not, use `influence` from `POST /user/trustSignals` with their token, in batches of 500. The second path is what makes personalising "silent": it needs no extra signature.
- **The line:** rank 2 or higher counts (Brainstorm's line, per the design brief; confirm the value in Brainstorm-UI's trust policy). On the API path, use the server's `verified` flag. An account with no score counts as outside.
- **`flagged` reviewers never count**, and their reviews are folded with the rest of the outside ones.
- **The viewer's own review always counts in My circle**, at full weight.
- **Nobody gets a head start.** Tapestry's vote counter gives an item's author an implicit upvote. Stars have no such thing; if place-level votes are ever added, leave the filer's implicit vote out, or every place starts with the curator's 0.07.
- **Ranking a list:** damp small samples so one five-star from one person does not top the page. Start with `(Σ weight × stars + 1.5 × 3.5) / (Σ weight + 1.5)` for ordering only; show the plain `score` as the number. Both constants are tunable; put them in config.
- **Chains:** each location has its own score. The chain screen shows the range across nearby locations, not an average.
- **What the interface says:**
  - `counted ≥ 1`: the score, the count, and names: "Maya, Jon and 5 others in your circle" / "Rated by 9 people the house trusts".
  - `counted = 0`, other reviews exist: "No score yet. Nobody in your circle has been here yet. 11 other people have rated it."
  - No reviews at all: "Be the first in your circle." This is the most common state at launch.
- **Reviews outside the point of view are folded, never dropped:** "12 more from people outside your circle", one tap to open, shown dimmed, with a link to the explanation screen.
- **"How much this person counts"** on a person's page is the same weight on a five-step meter. Put the thresholds in config.
- **Toggling views must not refetch places or reviews.** Fetch both sets of reviewer weights, cache them for the session, and recompute.

---

## 6. Personalising: "silent", but not secret

Sequence after sign-in:

1. Challenge → signed event → token (§ 3.3). Keep the token in memory or session storage; never in a URL.
2. `GET /user/graperankResult`. If a recent result exists, My circle is ready now.
3. Otherwise `POST /user/graperank`, then poll the result. This takes minutes. Show the quiet "Working out your circle" state (§ 10, screen 11) and keep House picks usable.
4. When ready, enable the toggle. Do not switch the view for them mid-scroll; tell them it is ready.

Handle these honestly:

- **Quota or "too recent" (`429`, `403`):** "Your circle was updated recently. We'll use that." Then use the existing result.
- **Server unavailable:** stay on House picks; say My circle is unavailable for now.
- **An empty or tiny circle.** A person who trusts nobody yet gets a circle of one. Say so plainly and keep House picks as the useful view. **This is the main product risk:** for someone new to the network, My circle is empty until they use the Trust button (§ 7).
- **What the person is told.** Triggering a calculation makes Brainstorm create a scoring assistant for that account and publish scores publicly. Brainstorm-UI has an explicit consent step for this. **Ask Avi whether this app needs one**, and keep the one-line notice on the sign-in screen until he decides.

---

## 7. "Trust" is a follow, and follows are easy to destroy

The Trust button on a reviewer adds them to the signed-in person's follow list (kind 3), which is what Brainstorm's scoring reads. A kind 3 event **replaces the whole list**. Publishing one built from a stale or missing copy wipes every follow the person has, everywhere.

- Fetch the current kind 3 from several relays (the person's own relay list if they have one, plus the general ones) and take the newest.
- If none is found for an account that is not brand new (it has a profile, or anyone follows it), **stop and say you couldn't load their list**. Do not publish.
- Append only. Preserve every existing tag and the `content` field exactly.
- Publish to the same relays you read from, then read back.
- After a successful change, My circle is stale until the next calculation; say "Counts for more after your circle's next update."

Removing someone takes out one `p` tag under the same rules.

---

## 8. Architecture — recommended shape; confirm the stack with Avi

**Client-first, with all signing in the browser.** The whole list is about 6 MB, so the app can load it once and keep it on the device, or query by area with geohash prefixes (`#g`).

- **Places:** load once into local storage (for example IndexedDB), build the search and geographic indexes in the browser, and refresh in the background. Group chains and merge same-`osm-id` filings there.
- **Reviews and reviewer weights:** fetched for the places on screen, cached for the session.
- **A small server is optional and comes later**, for two things only: a real, fast-loading URL per place that can be shared, and sparing phones the first 6 MB download. If one is added it mirrors public facts only.
- **Never stored anywhere:** per-viewer scores. Never on a server: tokens or anything private.
- **Optimistic writes:** show a posted review immediately; reconcile when a relay returns it.
- **Maps:** a vector map library with a hosted tile provider. Do not point a production app at OpenStreetMap's own tile servers; their usage policy forbids heavy use. Ask Avi which provider.
- **Type:** the canvas uses Bricolage Grotesque for display and Figtree for text. Both are Latin-only, and 103 place names use other scripts. Fall back to the Noto Sans family for names, per script.
- **Stack:** ask Avi what his other apps (Unbnd, Trustwave) use and match it unless there is a reason not to.

---

## 9. Sign-in

- **Browser signer (NIP-07) first.** Optional second: remote signer (NIP-46) for phones.
- The app never sees, stores or asks for a private key. No "paste your key" field, ever.
- Signed out is a complete experience: House picks, map, search, place pages, reading reviews.
- Sign-in is requested only when needed: to switch to My circle, post a review, mark one helpful, trust a reviewer, save a place or add one.
- No signer on the device: the sign-in screen links to "How signing in works" on the About screen.

---

## 10. Screens (from the design canvas; build these)

**Look:** white ground; ink `#16202E`; surfaces `#F3F5F7`; lines `#E2E6EB`; muted text `#5A6675`; one warm accent `#C93A22` (stars, primary button, active tab, selected map pin); one trust colour `#0B6E69` with tint `#E3F1EF` (anything about who you trust, and nothing else). Corners 16–22 px. Touch targets at least 44 px.

**No photographs anywhere.** A place is drawn from its kind icon (ten line icons, one per family in the design brief's catalogue table), its name, distance, open state and the people behind its score. A static map tile stands in for a hero image on the place page.

**A place card, everywhere:** kind icon · name · score · "kind or cuisine · distance" · open state ("Open until 10 pm", "Closed · opens 7 am", "Hours not listed") · who the score comes from · one quoted line.

*Find a place*

1. **Explore, list.** Wordmark, account button. "Near Nashville". Search field. **The House picks / My circle toggle with a one-line explanation and "How this works".** Chips: All, Open now, Restaurants, Cafes, More. Cards as above; a chain is one tinted card ("Coffee shop · 74 locations · 3 near you, the closest 0.6 mi"); a place nobody in the view has rated gets a dashed card. Tabs: Explore, Map, Saved, You.
2. **Explore, map.** Full-bleed map. Pins are score pills; the selected one is accent-coloured; unrated places are small rings; a chain pin shows "×3"; dense areas collapse to a count. Search field and the toggle float on top; "Search this area"; attribution on the map; the selected place's card at the bottom.
3. **Search results.** Query field, active filter chips, "5 places near Nashville. Best in My circle first." Compact rows. A long name wraps to two lines. A note says how many were hidden as closed, and that places without hours stay in. "Can't find it? Add a missing place."
4. **Filters.** Sort (My circle's score, Distance, Name); Open now; Distance; the ten kinds as a two-column grid with icons. No payment filter.
5. **Chain.** Name, "74 locations · 3 near you". "Each location is scored on its own." Nearby locations listed by address, each with distance, open state and its own score. "Show all 74 locations."

*Decide, and say what you think*

6. **Place.** Kind icon, name, "kind · distance", open state. Score panel: big number, stars, "From 7 people in your circle", their faces and names, "People closer to you count for more", and the toggle with both scores. "What your circle says": tag chips with counts (behind the § 4.4 switch). Go / Call / Site, showing only the ones the place has. Map. Address, hours, phone, and a payment row with the **Bitcoin accepted** chip. "From your circle": reviews with who the reviewer is to you ("You trust Maya" / "Trusted by Maya and 2 others"), stars, date, text, a Helpful button, and a **Trust** button on people you don't trust directly. Then a dashed box: "12 more from people outside your circle. Folded away, not removed." with "Show them" and "Why are these folded?". Footer: "Also listed by…", "Something wrong? Suggest a fix", attribution.
7. **Place, no reviews yet.** The launch-day state. Facts carry the page: "Hours not listed" in grey, only the actions the place has, a line asking for the missing details. A dashed panel: "Be the first in your circle" with "Rate this place". Below: "Nearby, rated by your circle".
8. **Write a review.** Place name. Five large star buttons with a word for each level. Tag chips to switch on, and "Add your own". An optional text box ("What should a friend know?"). "Reviews are public and carry your name. One review per place: posting again replaces this one." Post.
9. **Person.** Initial, name, "Trusted by Maya, Jon and Dele, who you trust". A panel: "How much Tomás counts in your scores", a five-step meter, one sentence, and **Trust Tomás**. Three numbers: reviews, found helpful, lists. Their lists, each with "Save list". Their reviews.

*You and your circle*

10. **Sign in.** Dark full-screen sheet. "Ratings from people you'd actually ask." Three numbered steps. **Continue with Nostr** and "Keep House picks". The notice from § 6, and "First time? How signing in works".
11. **Getting your circle ready.** Explore, with a banner: "Working out your circle. This takes a few minutes." The My circle half of the toggle is disabled and reads "soon".
12. **Why you see what you see.** "There is no single score for a place. Every score here is worked out from a set of people. You choose which set." The toggle. "212 people in your circle": people you trust, people they trust, when it was worked out, "Update now". Three rules: only your circle counts; closer people count for more; one say each. "What gets folded away." The people you trust, each with Remove. "And House picks?"
13. **Saved and lists.** Lists as tiles, including one saved from another person. An open list with Share and "Lists are public." A row for a place that closed: "No longer listed. It came off the map at the last monthly refresh" with "Remove from list". One name in Japanese shows the fallback typeface at work.
14. **Add or fix a place.** First a panel: details come from OpenStreetMap; "Fix it on OpenStreetMap". Then a form: name, kind, optional address, a pin on a map. A duplicate warning: "There's a cafe called Paper Crane Coffee about 40 metres from your pin" with "Yes, open it" / "No, it's different"; the Add button stays off until it is answered.
15. **About and data.** Where the places come from (OpenStreetMap via BTC Map; 7,954 places, 115 countries, last refreshed 5 October 2026, monthly; licence line and link). Where the reviews come from. Who the house is. How signing in works. "Your reviews are yours."

*Desktop (the canvas's second page, "Desktop")*

One responsive app, not two. The phone screens above are the narrow layout; these six show the wide one. Everything stacks back to the phone layout as the window narrows.

- **The shell.** One top bar on every page: wordmark, search field with the location inside it, the House picks / My circle toggle, Saved, the account button. No bottom tabs.
- **D1 · Explore.** The list and the map side by side: list about 520 px wide on the left, map filling the rest. The phone's filter sheet becomes a row of menus above the list (Open now, Kind of place, Distance, Sort). The card for the selected map pin gets a dark outline. Phone screens 1 to 4 collapse into this one page.
- **D2 · Place.** A content column (name, score panel, tags, reviews, the folded box) and a side rail about 320 px wide (Write a review, Go / Call / Site / Save, map, facts with the **Bitcoin accepted** chip, "Also listed by", "Suggest a fix", attribution). Review text is capped at about 68 characters a line.
- **D3 · Write a review.** A dialog over the place page, not a separate page. Same fields as phone screen 8.
- **D4 · Why you see what you see.** The explanation on the left, with the three rules as cards in a row; the circle count and the people you trust in the rail.
- **D5 · Saved and lists.** Lists down the left, the open list as a grid of place cards.
- **D6 · Sign in.** Full dark page: the headline on the left, the steps and buttons in a white card on the right.
- **Not drawn, same pattern as D2:** Chain, Person, Add or fix a place, About, and the place page with no reviews.

**States not drawn yet:** location denied, offline, no search results, a review that failed to post, the signed-out version of screen 12, a person outside your circle, an empty Saved. Write them in the same voice.

The relationship line "Trusted by Maya and 2 others" needs follow-graph data the app may not have cheaply. First version: "You trust Maya" for direct follows, "In your circle" otherwise.

Everything on the canvas is invented sample content except the four figures on the About screen. Do not ship any of it.

---

## 11. Launch reality

- **Zero reviews exist.** Every place opens on screen 7 unless Avi and the team seed some. Ask Avi how many reviews, by whom, in which city, before any public link.
- **House picks is only as good as Mise en Place's follow list.** Three follows will not carry a city.
- **Pick one city to launch.** The list covers 115 countries and is thin almost everywhere; depth in one place beats coverage.
- **Every place accepts bitcoin today**, because the list was seeded from BTC Map. The chip will be on every page until other places are added. Avi knows; do not "fix" it by hiding the chip.

---

## 12. Decisions

The design brief lists eight. Where each stands:

| # | Decision | Status |
|---|---|---|
| 1 | The review primitive | **Decided by Avi:** stars plus optional text, kind 34259, with tags alongside. David and Vinney have not seen it. |
| 2 | Point opinions at the address, not the event id | **Adopted** (§ 4.1). |
| 3 | Which relays hold reviews | **Open** (§ 4.2). |
| 4 | What counts as the same place | **Adopted:** `osm-id` (§ 3.1, § 4.3). |
| 5 | The trust line, and what signed-out visitors see | Rank 2 adopted. Signed-out visitors see **Mise en Place's** view; the design brief says Brainstorm's. **Confirm with Avi.** |
| 6 | What a reviewer gets back | Drawn as a profile, a helpful count and lists others can save. Tips left out. **Avi to confirm.** |
| 7 | Tags need the W20 fix | **Blocked** on `feat/tags`; built behind a switch. |
| 8 | Name and brand; fold into brainstorm.world or stand alone | **Name decided: Regulars, standing alone at `askregulars.world`.** Folding into brainstorm.world later is still open. |

Also ask, do not decide:

9. Whether a consent step is needed before triggering a score calculation (§ 6).
10. Stack, hosting and the map tile provider (§ 8).
11. Launch city and the seeding plan (§ 11).
12. Whether flagged reviewers' reviews are folded with the rest or hidden outright.
13. Whether the About screen names BTC Map (§ 2).
14. Which of the fifteen screens are in the first build.
15. The contact address for the About screen (drawn as a placeholder).
16. How he wants the site deployed to `askregulars.world` (he manages the DNS at Namecheap).

---

## 13. Order of work, and what done means

1. Load the list on the device; confirm 7,954 places and the fill rates in the design brief.
2. Explore (list and map), search, filters, chain and place pages working signed-out, with every place in the "no reviews yet" state (true, today).
3. House weights: resolve the chain, read 30382s, compute. Prove it with test reviews on a **local** relay.
4. Settle § 4.2 with Avi → write and read reviews.
5. Sign-in, calculation, My circle, the toggle, the explanation screen.
6. Trust button with the § 7 safeguards; person page.
7. Saved lists; add or fix a place.
8. Tags, once the fix lands.

Done means:

- [ ] A signed-out visitor can search a city, open a place and read House picks without meeting a single protocol word.
- [ ] Searching the built interface text for "nostr" and "bitcoin" finds only the sign-in button and the place-page chip.
- [ ] The same place shows different scores under the two views for a test account, and toggling makes no network request for places or reviews.
- [ ] No per-viewer score is stored anywhere.
- [ ] A review posted in the app can be read back from the relay with a plain query, is replaced by posting again, and renders correctly in Brainstorm-UI.
- [ ] A review survives a refresh of the place it points at.
- [ ] The Trust button has been tested against an account with an existing follow list and preserved every entry.
- [ ] OpenStreetMap attribution is visible on every map and wherever place details are.
- [ ] No private key or session token appears in any log, URL or stored file.

## 14. Do not

- Hardcode the house scorer's pubkey or relay; resolve them from the house account.
- Use Brainstorm's unauthenticated scores as House picks.
- Store or cache a score per viewer.
- Publish test places, reviews, votes or follow lists to production relays.
- Publish a follow list you could not first read.
- Point a review, a vote or a saved entry at an event id.
- Merge places by name.
- Invent ratings, reviews, photos or prices to make a page look fuller.
- Invent a new review format. Kind 34259 is the choice; if it will not work, stop and ask.

---

## Sources

- Avi's design brief, `food-and-drink-design-brief.md` (2026-10-07), and the importer [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place).
- `NosFabrica/brainstorm_server` at `dc8c4f3`: `app/routers/user/router.py`, `app/routers/auth_challenge/router.py`, `app/api.py`, `app/services/manual_quota.py`.
- `NosFabrica/Brainstorm-UI` (branch `staging`, read at `d874bd7`): `client/src/lib/thing.ts` (`starsOf`, `MARK_NOUNS`, the 34259 case), `client/src/components/share/things/ReviewPage.tsx`, `client/src/services/search.ts`, `client/src/services/api/graperank.ts`, `auth.ts`, `client/src/services/trustSource.ts`.
- `nous-clawds4/tapestry`: `CLAUDE.md` (invariants), `protocols/drafts/event-taggings.md`, `protocols/worksheet.md` (W20), `ui/src/utils/dlistScore.js`.
- Review format: https://github.com/nostr-protocol/nips/pull/1914 (open). Earlier proposals, not used: [#879](https://github.com/nostr-protocol/nips/pull/879), [#2115](https://github.com/nostr-protocol/nips/pull/2115).
- Live reads on 2026-10-05 to 07 from `wss://dcosl.brainstorm.world` and `wss://scores.brainstorm.world`.
