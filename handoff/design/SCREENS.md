# Screens

Twenty-one screens: fifteen for phone, six for desktop. It is one responsive app; the phone screens are the narrow layout and the desktop pages the wide one.

Each screen is in `screens/static/<Name>.html` (open this) and `screens/source/<Name>.dc.html` (read this for exact values). Section 10 of `REGULARS_APP_BRIEF.md` describes what each must do.

## Phone (390 px wide)

| # | File | Screen | State shown | Leads to |
|---|---|---|---|---|
| 1 | `Main.dc.html` | Explore, list | House picks selected. The source also holds the My circle list. | Search, Filters, Place, Chain, Map, Saved, Trust |
| 2 | `Map.dc.html` | Explore, map | My circle; one pin selected, with its card | Search, Place |
| 3 | `Search.dc.html` | Search results | Query "coffee", two filters on, sorted by My circle | Filters, Place, Chain, PlaceNew, AddFix |
| 4 | `Filters.dc.html` | Filters | Sort, Open now, distance, ten kinds | Search |
| 5 | `Chain.dc.html` | Chain | 74 locations, 3 nearby, one with no reviews | Place, PlaceNew, Map, AddFix |
| 6 | `Place.dc.html` | Place | My circle; 7 counted reviews, 12 folded | Review, Person, Saved, Trust, AddFix, About |
| 7 | `PlaceNew.dc.html` | Place, no reviews yet | No hours, phone or website either | Review, AddFix, Place |
| 8 | `Review.dc.html` | Write a review | 4 stars picked, two tags on | Place |
| 9 | `Person.dc.html` | Person | Someone in your circle you don't trust directly | Place, Trust |
| 10 | `SignIn.dc.html` | Sign in | Signed out | Tuning, Main, About |
| 11 | `Tuning.dc.html` | Getting your circle ready | Calculation running; My circle disabled | Place |
| 12 | `Trust.dc.html` | Why you see what you see | Signed in, My circle | Person, About, SignIn |
| 13 | `Saved.dc.html` | Saved and lists | One list open, one place no longer listed | Place, PlaceNew |
| 14 | `AddFix.dc.html` | Add or fix a place | Duplicate warning showing; Add disabled | Place |
| 15 | `About.dc.html` | About and data | — | Trust, AddFix |

## Desktop (fluid; drawn at 1360 px)

| # | File | Page | State shown | Phone screens it replaces |
|---|---|---|---|---|
| D1 | `DeskExplore.dc.html` | Explore: list beside map | My circle. The source also holds the House picks list. | 1, 2, 3, 4 |
| D2 | `DeskPlace.dc.html` | Place | My circle; content column and side rail | 6 |
| D3 | `DeskReview.dc.html` | Write a review | A dialog over a dimmed page | 8 |
| D4 | `DeskTrust.dc.html` | Why you see what you see | Signed in | 12 |
| D5 | `DeskSaved.dc.html` | Saved and lists | One list open | 13 |
| D6 | `DeskSignIn.dc.html` | Sign in | Signed out | 10 |

Not drawn for desktop: Chain, Place with no reviews, Person, Getting your circle ready, Add or fix, About. Give them the D2 layout: the shared top bar, a content column, and a side rail where the phone screen has secondary content.

## Parts that repeat

Build each once.

| Part | Where to read it | Notes |
|---|---|---|
| Top bar (desktop) | `DeskExplore` | Wordmark, search with location inside, the toggle, Saved, account |
| Bottom tabs (phone) | `Main` | Explore, Map, Saved, You. Phone only. |
| House picks / My circle toggle | `Main`, `Place` | The place page's version carries both scores |
| Place card | `Main` | Kind icon, name, score, "kind · distance", open state, who the score is from, one quote |
| Place row | `Search` | The compact card; long names wrap to two lines |
| Chain card and row | `Main`, `Search` | Tinted; a count of locations where a score would be |
| Unrated card | `Main` (My circle list) | Dashed border, "No score yet" |
| Score panel | `Place` | Number, stars, count, faces and names, the toggle |
| Review | `Place` | Person, relation to you, stars, date, text, Helpful, and Trust when not yet trusted |
| Folded reviews box | `Place` | Dashed; "Show them" and "Why are these folded?" |
| Tag chips | `Place`, `Review` | Read-only with counts on Place; switches on Review |
| Map pin | `Map` | Score pill; selected (accent); unrated (ring); chain ("×3"); cluster (count) |
| Stars | everywhere | Five 16 px stars; filled `#C93A22`, empty `#D5DAE0` |

## Wording patterns

- Kind label on a card: the cuisine and the kind where both exist ("Mexican restaurant", "Seafood restaurant"); "Coffee shop" for a cafe whose cuisine is coffee; otherwise the kind alone ("Bakery", "Cafe"). `kinds.json` has the kind labels.
- Open state: "Open until 10 pm" · "Closed · opens 7 am" · "Hours not listed". On the place page: "Open now · closes 10 pm".
- Who a score is from: "Maya, Jon and 5 others in your circle" · "Maya in your circle" · "Rated by 9 people the house trusts".
- No score: "No score yet" when others outside the view have rated it; "No reviews yet" when nobody has.
- Relation to a reviewer: "You trust Maya" · "Trusted by Maya and 2 others".

## States not drawn

Location denied; offline; no search results; a review that failed to post; the signed-out version of screen 12; a person outside your circle; an empty Saved; the place page under House picks when signed out. Write these in the same voice and show Avi before building them out.
