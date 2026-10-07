# Food and Drink Places: reference app design brief

Oct 7, 2026 · Avi

A web-of-trust restaurant app can be designed now on 7,954 bitcoin-accepting food and drink places that are live on nostr. The list carries facts only, so reviews, ratings and photos are the layer this app adds, on Tapestry's trust model.

## Where it stands

The whole BTC Map food and drink catalogue has been live on two relays since 5 October 2026. Brainstorm.world does not show it yet; registering it is on the NosFabrica backlog.

| Piece | State | Detail |
| --- | --- | --- |
| The list (DList header) | Live | "Food and Drink Places", signed by Avi. Coordinate `39998:b83a28b7…:food-and-drink-places` |
| The places (items) | Live, 7,954 | Kind 39999, one per place, signed by the Mise en Place curator (`npub1f00dy9…`) |
| Relays | Both verified clean | `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world` |
| Curator trust | In the web of trust | Rank 7 from the brainstorm.world house view; the verified line is 2 |
| Display hints on the header | Live, confirmed by Vinney | title = `name`, summary = `address`, image = `image`, link = `website` |
| Importer and dev console | Built, on GitHub | [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place): fetch, build, sign, publish, verify, monthly refresh, local map console |
| Brainstorm.world | Not yet | Needs one line in Brainstorm-UI's `dictionary.config.json`, then a release. Brainstorm reads at most 500 items per list today |
| Full-text search on the search relay | Signed-in readers only | Plain filter reads work with `include:spam`; text queries need a web-of-trust observer |
| Reviews, ratings, photos | Not started | The app defines these; see The social layer |

The list refreshes monthly from BTC Map. Changed places republish under the same address; closed places get a deletion event and disappear from relays.

## What one place looks like

Each place is a flat set of named fields, and only name, kind and location are always present. Design every slot for its real fill rate: a slot filled half the time needs a graceful empty state.

| Field | Filled | Example (Dew Restaurant, Pacific City, OR) | Design note |
| --- | --- | --- | --- |
| `name` | 100% | Dew Restaurant | Median 15 characters, 99% under 40, longest 67. 103 names use non-Latin scripts |
| `category` | 100% | restaurant | Raw OSM value (`fast_food`, `ice_cream`); the app maps 29 values to labels and icons |
| `lat`, `lon`, `g` | 100% | 45.206, -123.960; geohash `c0pc5jwcz` + prefixes | Map pin and "near me". Geohash prefixes at 9, 6, 5, 4 characters allow relay queries by area |
| `country` | 100% | US | ISO code, computed from coordinates |
| `accepts-bitcoin` | 100% | lightning | `lightning` 5,156 · `both` 2,277 · `yes` (method unknown) 363 · `onchain` 158 |
| `address` | 85% | 6395 Shade Street Pacific City 97135 | One line, no commas (BTC Map's format). Median 37 characters, max 115 |
| `locality` | 79% | Pacific City | City as OSM spells it, typos included ("Ft. Lauterdale") |
| `postal-code` | 75% | 97135 | |
| `opening-hours` | 73% | Sa 17:00-21:00 | OSM syntax, needs a parser for "open now". 44 places are `24/7`; a few are malformed |
| `phone` | 67% | +1-503-572-2665 | |
| `website` | 58% | dewrestaurant.com | Validated https URL |
| `cuisine` | 52% | japanese | First value only. Top: coffee shop 734, burger 573, pizza 351, mexican 273 |
| `region` | 44% | OR | State or province code |
| `description` | 6% | | Median 73 characters. Don't design around it |
| `image` | 0.5% | | 39 places of 7,954. Plan for no photos |
| `t` | 100% | restaurant, japanese, pacific city | Search keywords: kind, every cuisine, city |
| `osm-id`, `btcmap-id`, `source`, `license` | 100% | node:13431202842 | Provenance and the ODbL licence; link out to OSM and BTC Map |

There is no rating, price level, photo set, menu or review in the data. Those fields exist on the header for people to add later (`price-range`, `menu`, `reservations`), but the importer never fills them.

## The catalogue at a glance

Restaurants, cafes and fast food make up most of the list: 72% of the 7,954 places are one of those three kinds.

| Kind (grouped) | Places | OSM values included |
| --- | ---: | --- |
| Restaurants | 2,558 | restaurant |
| Cafes | 1,581 | cafe |
| Fast food | 1,558 | fast_food |
| Bars and pubs | 594 | bar 364, pub 226, biergarten 4 |
| Food shops, other | 388 | butcher 91, health_food 57, deli 57, coffee 52, greengrocer 51, seafood 25, cheese 15, tea 14, dairy 11, spices 8, food_court 7 |
| Bakeries and sweets | 357 | bakery 228, pastry 56, chocolate 37, confectionery 36 |
| Farm shops | 302 | farm |
| Drink shops | 286 | alcohol 169, wine 72, beverages 45 |
| Ice cream | 230 | ice_cream |
| Breweries, wineries, distilleries | 100 | brewery 48, winery 40, distillery 12 |

Source: BTC Map fetch of 5 October 2026, 7,954 places in scope, grouped from 29 OSM kinds. (In the online doc this table is a bar chart.)

The places span 115 countries, and 43% are in the US (3,457), followed by El Salvador (564) and Brazil (461). Chains repeat: 356 names occur more than once, led by Steak 'n Shake with 317 locations, so list and map views need a way to group a chain.

## The social layer

Tapestry already gives this app trust-weighted votes and attribute tags. Written reviews, star ratings and photos each have a nostr building block but no Tapestry convention yet, so this app sets that convention.

| Capability | Exists today | Where | What the app must settle |
| --- | --- | --- | --- |
| Up and down votes | Yes, implemented | NIP-25 kind 7; Tapestry `dlistScore.js` weights each vote by the voter's rank / 100 | Tapestry counts votes per event id, so a monthly republish of a changed place zeroes them. Point votes at the place's address (`a` tag), as NIP-25 recommends |
| Attribute tags ("vegan options", "good for groups", cuisine) | Yes, specified and built | Tapestry event taggings: one ±1 stance per person, tag and place, counted per viewer's trust | Known bug W20 on staging: one person tagging two places by the same author keeps only the last. All 7,954 places share one author, so this needs the fix from `feat/tags` first |
| Written reviews and comments | Building block only | NIP-22 comments (kind 1111) can point at an addressable item. Brainstorm built them for tags, then switched them off | Which relay stores them: dcosl accepts list kinds and kind 7, and turned 1111 away |
| Star ratings | No merged standard | Open proposals: #1914 (kind 34259), #879 (31985–31987), #2115 (30016). Brainstorm already shows 34259 and 31987 with a plain average | Whether to have stars at all, and which kind; or votes plus tags instead |
| Photos | Building blocks only | NIP-68 picture posts, NIP-92 `imeta`, Blossom file servers | How a photo points at a place (an `a` tag is the app's own convention) and how photos are moderated |
| Proof of a visit | Nothing merged | #2117 proposes verified-review attestations for reservations | Probably out of scope for a reference app; note it as future work |
| Tipping | Exists, poor fit | NIP-57 zaps pay a person, and places have no nostr identity | A zap on a place would pay the curator. Zapping a helpful reviewer fits |
| Saved places and lists | Yes | Personal DLists; curation copies point back at the original with `q` tags | List names and whether lists are public by default |
| Trust scores | Yes, implemented | NIP-85 rank (kind 30382), found through the viewer's Treasure Map (kind 10040) | Nothing; reuse Brainstorm's approach |

Tapestry's own design notes favour signals people show by acting over what they tell, and they note that a five-star review sits at the "tell" end and is easier to fake. They also warn that people only write reviews when they get something back. The screens should make reviewing worth it: building a reputation people can see, lists others follow, or tips.

## Trust in the interface

Trust filters the people who review, vote and tag, not the places. Every place comes from one curator that is inside the web of trust (rank 7, against a line of 2), so trust sorts opinions, never listings.

**How the app knows whom to trust:**

1. A signed-in viewer's Treasure Map (kind 10040) names a trust scorer and its relay.
2. The app reads that scorer's rank for each reviewer (kind 30382), a number from 0 to 100.
3. A signed-out viewer, or one with no Treasure Map, gets the house view. Brainstorm.world publishes its house scorer at `/.well-known/nostr.json?name=_`, with scores on `wss://scores.brainstorm.world`.
4. Rank 2 or higher counts as trusted (Brainstorm's line). An unranked account counts as outside.

**Patterns already proven in Brainstorm, worth reusing:**

- Opinions from outside the web of trust are folded away, not deleted: "Show 12 more from accounts outside your web of trust". Expanded, they appear dimmed.
- Loading and failure states are explicit: "Checking who's in your web of trust…" and "Couldn't reach a trust scorer".
- A perspective switch: "My perspective" or "Default", for people with their own scorer.

**What makes this hard to game, and how the screens should show it:**

- **Weighted, not counted.** A vote weighs the voter's rank / 100, and unscored accounts weigh nothing. When Brainstorm applied this to tags, 85 of 106 taggers were unscored, and 89.6% of taggings dropped out, most of them from a test harness.
- **Show the basis, not just a score.** "4 people you trust liked this" says more, and is harder to fake, than an anonymous 4.6 stars from 312 reviews. Put the people (avatars, names) next to the number.
- **One voice per person.** Each person gets one stance per place and per tag; a second replaces the first.
- **The curator doesn't vote.** Tapestry counts an item's author as an implicit upvote. Exclude it here, as Tapestry's GUM₁ measure excludes the list's own author ("self-evidence is not community evidence"). Otherwise every place starts with the curator's 0.07.
- **Explain hiding.** Any hidden review should be one tap from "why is this hidden" and the viewer's trust settings.

**Cold start.** At launch almost no place has a review from anyone, let alone from someone you trust. The place screen's most common state will be "no opinions yet". Design it as an invitation ("Be the first in your network") rather than a blank, and lean on facts (open now, distance, bitcoin method) to carry the screen until opinions arrive.

## Screens to design

Eleven screens cover a complete reference app. Five run on today's data alone; the rest need the social layer this app adds. "Today" means the field exists on the live list now.

| Screen | Job | Data today | Added by the app | States to design |
| --- | --- | --- | --- | --- |
| Explore (map + list) | Find a place near me | Location, kind, hours, bitcoin method | Trusted score per place, "friends went here" | Location denied; empty area; dense cluster; offline |
| Search and filters | Find by name, cuisine or city | Name, `t` keywords (kind, cuisines, city), kind, open now | Sort by trusted score | No results; typo-tolerant suggestions |
| Place | Decide whether to go | Every field in What one place looks like, OSM and BTC Map links | Reviews from my network vs everyone, tags, saves, "also listed by" | Missing hours, phone, site; no reviews yet; no longer listed |
| Chain | One card for many locations | Same-name places | Chain-level score | Chain with 1 location near me |
| Write a review | Say what I think | The place it points at | The review event, rating if any, photos if any | Draft; signing; failed to publish |
| Person | Should I trust this reviewer | Profile from nostr (kind 0) | Their reviews, their rank from my view, who I follow who follows them | Unranked person; my own profile |
| My trust view | Why do I see what I see | Treasure Map and rank events (kind 10040, 30382) | Choose "my perspective" or the default; explain hidden items | Signed out (default view); no scores computed yet |
| Saved and lists | Keep places for later | List addresses | Personal lists, which are DLists of my own | Empty; a saved place that closed |
| Add or fix a place | Fill a gap in the map | Header fields: `name` and `category` required | Filing my own item; a "Fix on OpenStreetMap" path | Duplicate detected; missing location |
| Sign in | Act as myself | None | NIP-07 browser extension or NIP-46 remote signer | Signed out but browsing; extension missing |
| About and data | Credit and explain | Header, curator, licence | Source, licence and refresh date | None |

## Design considerations

The biggest design constraint is that 99.5% of places have no photo. The visual system has to make a place look good from its name, kind, location and hours alone.

- **No photos.** Options, combinable:
    - an illustration or icon system for about 10 families of kind (the catalogue groups above);
    - a static map tile of the place's surroundings as the card image;
    - strong typographic cards;
    - community photos later (see The social layer).
- **Labels for raw values.** Kinds arrive as OSM values (`fast_food`, `ice_cream`), and cuisines as about 100 values (`coffee_shop`, `bubble_tea`). The app needs a label and icon map for both. Unknown values fall back to a title-cased label.
- **Hours are machine syntax.**
    - `Mo-Sa 07:00-15:00; Su off` needs an OSM opening-hours parser to show "Open now, closes 15:00", in the place's own time zone (derive it from coordinates).
    - 27% have no hours ("Hours not listed").
    - A few are malformed; show the raw text rather than nothing.
- **Text lengths.** Names: median 15 characters, 99% under 40, maximum 67. Addresses: median 37, maximum 115, one line with no commas. 103 names are in non-Latin scripts, so pick a typeface with wide script coverage.
- **Source typos stay.** Names and cities appear exactly as OSM spells them ("Ft. Lauterdale"). The app links each place to its OSM page with a "Suggest a fix" path. A fix made there reaches the app at the next monthly refresh.
- **Chains.** 356 names repeat. Steak 'n Shake alone has 317 locations, and a regional coffee chain 74. Without grouping, a chain floods search and the map. A chain card ("Steak 'n Shake · 317 locations, 2 near you") solves it.
- **Bitcoin is the common thread.** Every place takes bitcoin: Lightning, on-chain, both, or method unknown. A small consistent badge works better than a headline feature. Square terminals account for about a third of places but are not marked in the data.
- **Places change and close.**
    - A changed place keeps its address (`39999:<curator>:<d>`) and gets a new event id.
    - Reviews and saves must point at the address, never the event id, or they orphan on every refresh.
    - A closed place disappears from relays, so a saved or reviewed place needs a "No longer listed" state.
- **Other people can file places.** The list is open: anyone can add an item under the same header, and the app decides whose items count by trust. Two filers can list the same place (same `osm-id`), which calls for an "also listed by" treatment rather than duplicate cards.
- **Reading the data is cheap.** All 7,954 places come to about 6 MB. A reference app can load the whole list once and keep it locally, or query by area with geohash prefixes (`#g`). The search relay needs `include:spam` on reads.
- **Attribution is required.** OpenStreetMap's licence (ODbL) asks for "© OpenStreetMap contributors" on the map and an attribution line in the app ("Data from OpenStreetMap via BTC Map"). Design it in from the start rather than as a footer afterthought.

## Open decisions

Eight choices shape the screens. The first five change what the data model can show, so settle them before high-fidelity design.

- [ ] **The review primitive.** Votes plus written comments plus tags, or star ratings too. If stars, which proposed kind (34259 is what Brainstorm already renders).
- [ ] **Point opinions at the address, not the event id.** Recommended: the `a` coordinate `39999:<curator>:<d>`, so opinions survive the monthly refresh. This departs from Tapestry's current vote counter.
- [ ] **Which relays hold reviews and photos.** dcosl turned away comments (kind 1111). The app needs a relay for its social events, and a moderation stance for photos.
- [ ] **What counts as the same place.** Recommended: `osm-id`. Brainstorm's default (same name) merges every Steak 'n Shake into one place.
- [ ] **The trust line and its explanation.** Rank 2 like Brainstorm, or another cut; exclude the curator's implicit upvote; what signed-out visitors see.
- [ ] **What a reviewer gets back.** Visible reputation, followable lists, tips, or a mix. This shapes the profile and review screens.
- [ ] **Attribute tags need the W20 fix** from `feat/tags`, or a tag screen will silently drop all but one tag per person.
- [ ] **Name and brand of the reference app**, and whether it later folds into brainstorm.world or stays standalone.

## Sources

- Live data: the published list on `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`, verified 5 October 2026. Field fill rates and counts are computed from the BTC Map fetch of that day.
- Importer, spec and runbook: [aburra16/mise-en-place](https://github.com/aburra16/mise-en-place).
- BTC Map REST API v4: [teambtcmap/btcmap-api](https://github.com/teambtcmap/btcmap-api/tree/master/docs/rest/v4).
- Tapestry (nous-clawds4/tapestry, `staging`):
    - `protocols/nips/decentralized-lists.md`;
    - `protocols/drafts/event-taggings.md`, `pins.md`, `trust-determination-methods.md`, `opinionated-views.md`;
    - `design-philosophies/show-and-tell.md`;
    - `ui/src/utils/dlistScore.js`;
    - `protocols/worksheet.md` (W20).
- Brainstorm-UI (NosFabrica/Brainstorm-UI, `staging`):
    - `docs/dictionary/dlist-presentation-conventions.md`;
    - `client/src/services/wotRanks.ts`, `trustSource.ts`;
    - `client/src/config/tagging.ts`;
    - `client/src/lib/itemNeighbours.ts`.
- Vinney's rendering note: `docs/DECLARATIVE_DLIST_RENDERING.md` on Tapestry's `docs/declarative-dlist-rendering` branch.
- Nostr specs:
    - [NIP-22 comments](https://github.com/nostr-protocol/nips/blob/master/22.md), [NIP-25 reactions](https://github.com/nostr-protocol/nips/blob/master/25.md);
    - [NIP-57 zaps](https://github.com/nostr-protocol/nips/blob/master/57.md), [NIP-68 pictures](https://github.com/nostr-protocol/nips/blob/master/68.md);
    - [NIP-85 trusted assertions](https://github.com/nostr-protocol/nips/blob/master/85.md).
- Review proposals: [#879](https://github.com/nostr-protocol/nips/pull/879), [#1914](https://github.com/nostr-protocol/nips/pull/1914), [#2115](https://github.com/nostr-protocol/nips/pull/2115), [#2117](https://github.com/nostr-protocol/nips/pull/2117).
- Licence: [OpenStreetMap copyright and licence](https://www.openstreetmap.org/copyright).
