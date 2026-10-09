import { config } from "../config.ts";

/**
 * Every string a person can read lives in this file. tests/copy.test.ts fails on
 * protocol vocabulary anywhere in it (nostr, relay, key, sign ...), and in the kind
 * labels in src/data/kinds.json. These two strings are the only exceptions, and only as
 * the entire text of copy.signin.continueButton and copy.place.bitcoinChip.
 * "Sign in" and "Sign out" are the app's words for starting and ending a session, and "signed in"
 * and "signed out" may be said of the person (the M2b plan's ruling R7). No other "sign".
 */
export const ALLOWED_PROTOCOL_STRINGS = {
  signInButton: "Continue with Nostr",
  bitcoinChip: "Bitcoin accepted",
} as const;

/** A leaf is a string, or a template function that returns one. Groups nest freely; a list is strings. */
type CopyNode =
  | string
  | ((...args: never[]) => string)
  | readonly string[]
  | { readonly [key: string]: CopyNode };

/** The name of each page, as its heading reads until the page itself is built. */
const pages = {
  explore: "Explore",
  map: "Map",
  search: "Search",
  filters: "Filters",
  place: "Place",
  chain: "All locations",
  about: "About",
  signin: "Sign in",
  saved: "Saved",
  you: "You",
  /** The newest reviews (decision 31: named Trending now, ranked by recent activity later). */
  recent: "Trending",
};

/** How many places a chain has: "74 locations". */
const locations = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "location" : "locations"}`;

/** How many places: "7 places", "1 place". */
const places = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "place" : "places"}`;

/** How many people: "3 people", "1 person". */
const people = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "person" : "people"}`;

/** "1 other person", "3 other people". */
const otherPeople = (n: number) => `${n.toLocaleString("en")} other ${n === 1 ? "person" : "people"}`;

/** "1 other person has", "3 other people have". */
const othersHave = (n: number) => `${n.toLocaleString("en")} other ${n === 1 ? "person has" : "people have"}`;

/** "1 person has", "3 people have". */
const peopleHave = (n: number) => `${people(n)} ${n === 1 ? "has" : "have"}`;

/** How many reviews: "1 review", "4 reviews". */
const reviewCount = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "review" : "reviews"}`;

/** "a week ago", "3 weeks ago". */
const ago = (n: number, unit: string) => (n === 1 ? `a ${unit} ago` : `${n.toLocaleString("en")} ${unit}s ago`);

/** Over the place's name in the review form (Review.dc.html), and in its page's title. */
const yourReviewOf = "Your review of";

/** The word for each number of stars in the review form, from one to five (Review.dc.html). */
const starWords = ["Would not go back", "Below average", "Fine", "Good", "One of the best"] as const;

/** The point of view a place's score comes from before sign in, as a reviews line names it. */
const houseTrusts = "the house trusts";

/** The person's own point of view, My circle, as a reviews line names it. */
const inYourCircle = "in your circle";

/** People outside it, as a line names them. */
const outsideYourCircle = "outside your circle";

/** The heading of the kinds filter, and the name of the desktop's kinds menu while none is chosen. */
const kindOfPlace = "Kind of place";

/** A page's title in the browser's tab: "Search · Regulars". */
const pageTitle = (page: string) => `${page} · ${config.appName}`;

/** What joins the parts of a line: "Cafe · 0.3 mi", "Closed · opens 7 am". */
const dot = " · ";

/** A chain's kind and size (Main.dc.html): "Coffee shop · 74 locations". */
const chainKind = (kind: string, n: number) => `${kind}${dot}${locations(n)}`;

/**
 * How many of a chain's places are near where the places on screen are near, in the line under its
 * name: "3 near Funchal", "none near you". `near` is that place as the "Near …" control names it: a
 * town, or "you" only when it is the device.
 */
const nearCount = (n: number, near: string) => `${n === 0 ? "none" : n.toLocaleString("en")} near ${near}`;

/** "Near Funchal", "Near you": where the places on screen are near, as the "Near …" control says it. */
const nearLabel = (label: string) => `Near ${label}`;

/** What joins the two parts of the hours inside a line that dots join already (DeskPlace.dc.html): "Open now, closes 10 pm". */
const comma = ", ";

/**
 * The house: the curator whose trusted reviewers make House picks. Its badge goes beside this name
 * wherever the name is written (src/ui/HouseName.tsx), so the lines that name it take it from here.
 */
const houseName = "Mise en Place";

/** A link back to the first page. */
const backToExplore = "Back to Explore";

/** My circle can't be shown: its scorer's ranks can't be read, or the run that works the circle out failed. */
const circleUnavailable = "My circle isn't available right now.";

/** The name of the page that says how a score is worked out (Trust.dc.html, DeskTrust.dc.html). */
const whyTitle = "Why you see what you see";

/** Times in words where English has them ("now", "yesterday"), in the app's language. */
const relativeWords = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Times as a count ("1 week ago", never "last week"), in the app's language. */
const relativeCount = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** "phone", "phone or website", "phone, website or hours". */
const eitherOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

export const copy = {
  app: {
    name: config.appName,
  },
  house: {
    /** Its name. Also the words of its badge, should the badge ever be shown without the name beside it. */
    name: houseName,
  },
  meta: {
    description: "Restaurant ratings from people you'd actually ask.",
  },
  /** Words shared by more than one screen. */
  common: {
    /** After a link's own words, for a screen reader only: the link leaves the app. */
    newTab: "(opens in a new tab)",
    /** What joins the parts of a line: "Cafe · 0.3 mi". */
    joiner: dot,
    /** The link beside where the place details come from, to the page that says more. */
    aboutData: "About this data",
    /** A line of copy as a sentence on its own, in a panel: "2 other people have rated it." */
    sentence: (text: string) => `${text}.`,
  },
  /** The tabs on a phone, and the links in the desktop top bar. */
  nav: {
    /** The name of the tab bar, for a screen reader. */
    label: "Main",
    explore: "Explore",
    map: "Map",
    /** The tab, and the desktop top bar's link, to the newest reviews from the people behind the ratings (decision 31). */
    recent: pages.recent,
    // DRAFT for Avi
    /** The desktop top bar's links to pages (Trending, Saved), for a screen reader: not `label`, the phone's tabs. */
    pages: "Pages",
    saved: "Saved",
    you: "You",
    // DRAFT for Avi
    /** The round account button, for a screen reader, before sign in: pressing it signs the person in (decision 23). */
    signIn: pages.signin,
    // DRAFT for Avi
    /** The account button after sign in, for a screen reader: "Sofia, your account". */
    accountOf: (name: string) => `${name}, your account`,
    // DRAFT for Avi
    /** The account button after sign in, until the person's name is known. */
    yourAccount: "Your account",
    // DRAFT for Avi
    /** The moon and sun beside it, for a screen reader (pressed while the page is dark), and the words of its switch on You. */
    darkMode: "Dark mode",
  },
  search: {
    /** The search field's name, for a screen reader. */
    label: "Search places",
    placeholder: "Tacos, coffee, a restaurant name",
    /** The arrow at the top left of the results, for a screen reader. */
    back: backToExplore,
    /** The button at the end of the field, for a screen reader. */
    clear: "Clear search",
    /** The chip that opens the filters, with how many are on (Search.dc.html): "Filters · 3". */
    filters: (n: number) => (n === 0 ? "Filters" : `Filters · ${n}`),
    /** A filter that is on, as its chip says it: "Within 2 mi". */
    within: (distance: string) => `Within ${distance}`,
    /** The line under the chips (Search.dc.html): "5 places near Nashville. Nearest first." `sort` is one of the `sortedBy` lines. */
    summary: (n: number, near: string, sort: string) => `${places(n)} near ${near}. ${sort}.`,
    /** What order the results are in, as the end of that line. */
    sortedBy: {
      // DRAFT for Avi
      score: "Best in House picks first",
      // DRAFT for Avi: the design's words (Search.dc.html).
      /** The same, while My circle is the view. */
      circleScore: "Best in My circle first",
      distance: "Nearest first",
      name: "A to Z",
      // DRAFT for Avi: words that are not a kind of place are listed best match first.
      relevance: "Best match first",
    },
    // DRAFT for Avi
    /**
     * A chain in the results, in place of a rating (Search.dc.html, without its "near you"): how many of
     * its locations are near the "Near …" place, and how many of those are open: "12 nearby, 3 open now".
     */
    chainNearbyOpen: (near: number, open: number) =>
      `${near.toLocaleString("en")} nearby, ${open === 0 ? "none" : open.toLocaleString("en")} open now`,
    /** The button after the last row shown, when there are more. */
    showMore: "Show more",
    /** The box under the results when Open now left some out (Search.dc.html). */
    hiddenClosed: (n: number) => `${n.toLocaleString("en")} more ${n === 1 ? "is" : "are"} closed right now`,
    hoursNote: "Places with no hours listed stay in the results, since we can't tell.",
    showClosed: "Show closed places too",
    // DRAFT for Avi: the three lines below are the states the design does not draw.
    /** No place matches the words. `near` is where the search is around: "Funchal", or "you". */
    noResults: (q: string, near: string) => `No places match "${q}" near ${near}.`,
    noResultsHint: "Check the spelling, or try fewer words.",
    /** Places match the words, and all of them are closed, which Open now leaves out. */
    noResultsOpen: (q: string, near: string) => `No open places match "${q}" near ${near}.`,
    /** No place passes the filters, and nothing was typed. */
    noResultsFiltered: (near: string) => `No places near ${near} match those filters.`,
    noResultsFilteredHint: "Take off a filter to see more.",
    /** At the foot of the results, a link to add a place that is missing. */
    addMissing: "Can't find it? Add a missing place",
    // DRAFT for Avi
    /** Over the towns the words name, above the places (the towns brief's "Towns"). */
    townsHeading: "Towns",
    // DRAFT for Avi
    /**
     * A town the words name, as its row is named for a screen reader: "Prague, Czechia, 42 places". The
     * row reads "Prague, Czechia · 42 places", with the joiner and the town picker's count. `where` is
     * the town and its country.
     */
    townRowName: (where: string, n: number) => `${where}, ${places(n)}`,
    // DRAFT for Avi
    /** Over the places near, for a screen reader, between the towns and the places elsewhere. `near` is "Funchal", or "you". */
    nearHeading: (near: string) => `Places near ${near}`,
    // DRAFT for Avi
    /** Over the places farther away whose names have the words, below the places near. */
    elsewhereHeading: "Elsewhere",
    // DRAFT for Avi
    /** Under that heading, while a filter or a sort is on: they are for the places near, not these. */
    elsewhereUnfiltered: (near: string) => `Filters and sorting apply to the places near ${near} only.`,
  },
  filters: {
    /** The cross at the top right, for a screen reader. */
    close: "Close filters",
    sortBy: "Sort by",
    /**
     * The ways to sort. The first is by the ratings of the view on screen: House picks', which need no
     * sign in, or My circle's (the design's, Filters.dc.html) while it is the view (DRAFT for Avi).
     */
    sort: { score: "House picks' rating", circleScore: "My circle's rating", distance: "Distance", name: "Name" },
    openNow: "Open now",
    /** Under Open now: what it does with places whose hours are not known (Avi, 2026-10-09). */
    openNowNote: "Places with no hours listed stay in.",
    distance: "Distance",
    kinds: kindOfPlace,
    clearAll: "Clear all",
    /** The button that applies them (Filters.dc.html): "Show 5 places". */
    show: (n: number) => (n === 0 ? "No places match" : `Show ${places(n)}`),
    // DRAFT for Avi
    /** Said aloud, politely, when a filter changes how many places there are: "12 places match". */
    countStatus: (n: number) => (n === 0 ? "No places match" : n === 1 ? "1 place matches" : `${places(n)} match`),
  },
  /** The House picks / My circle toggle. */
  view: {
    // DRAFT for Avi
    /** The toggle's name, for a screen reader. */
    label: "Whose ratings to show",
    house: "House picks",
    circle: "My circle",
    /** A half of the toggle with its score, on the place page: "House picks · 4.5". */
    withScore: (view: string, score: string) => `${view} · ${score}`,
    // DRAFT for Avi
    /**
     * The My circle half while My circle is not open (`config.features.circle`): it is off, and says so
     * (the brief's screen 11; Tuning.dc.html). While it is open, the half reads `circle`: before the
     * circle is asked for, it opens Personalize (Avi, 2026-10-08); while it is looked for or asked for,
     * it is off, with a turning arrow after the words once Brainstorm works it out (Avi, 2026-10-09).
     */
    circleSoon: "My circle · soon",
    // DRAFT for Avi
    /** The half's name, for a screen reader, while Brainstorm works the person's circle out: its arrow turns on screen. */
    circleWorking: "My circle, being worked out",
  },
  /**
   * Personalizing: the action that asks Brainstorm, our scoring partner, to work out the person's
   * circle, in the panel My circle's half opens under the toggle, and what it says while it does
   * (decisions 8 and 26; the brief's screen 11, Tuning.dc.html). "Brainstorm" is the partner's name.
   */
  circle: {
    // DRAFT for Avi
    /** The button. Tapping it is the person's consent (decision 26). */
    personalize: "Personalize",
    // DRAFT for Avi: decision 26's line, beside the button. What is public is the circle Brainstorm works
    // out (who the person trusts, and whom they trust), not ratings of places.
    consent:
      "Personalizing asks Brainstorm, our scoring partner, to work out your circle. It sets up a public scoring profile for you, and your circle is public.",
    // DRAFT for Avi
    /** While the person's browser add-on asks them to let Brainstorm know it is them. */
    approveBrowser: "Approve the request in your browser add-on to go on.",
    // DRAFT for Avi
    /** The same, for a person who signed in with an app on their phone. */
    approvePhone: "Approve the request in the app on your phone to go on.",
    // DRAFT for Avi
    /** Stops waiting on the add-on or the app, and gives Personalize back. */
    cancel: "Cancel",
    // DRAFT for Avi: the first line of the bar at the foot of the screen, while Brainstorm works the circle out (Avi, 2026-10-09).
    // Also the hint over My circle's half while it is off for that, shown as the pointer rests on it (Avi, 2026-10-09).
    workingTitle: "Working out your circle",
    // DRAFT for Avi: the bar's second line.
    workingBody: "This takes a few minutes.",
    // DRAFT for Avi
    /**
     * In the bar, once the run the person started is done. It never switches the view: the toggle's My
     * circle half is on now, with a check after its words for a moment.
     */
    ready: "Your circle is ready.",
    // DRAFT for Avi: the brief's § 6.
    /** Brainstorm would not start a run, as one was made lately, and that run is the one used: in the bar, and beside Update now. */
    recently: "Your circle was updated recently. We'll use that.",
    // DRAFT for Avi
    /** Brainstorm would not start a run (too many from this address), and the person has none yet. */
    busy: "Brainstorm is busy right now. Try again in a little while.",
    // DRAFT for Avi: the brief's § 6. Avi approved the same words for `score.circleUnavailable` (2026-10-09).
    /** The run failed, or Brainstorm could not be reached. House picks still works. */
    unavailable: circleUnavailable,
    // DRAFT for Avi
    /** Beside `busy` or `unavailable`: personalizes again. */
    tryAgain: "Try again",
    // DRAFT for Avi
    /** The bar's ×, for a screen reader: puts the bar away before its time is up. */
    closeBar: "Close this message",
    // DRAFT for Avi
    /** In the panel My circle's half opens: closes it, asking Brainstorm nothing. */
    notNow: "Not now",
    // DRAFT for Avi
    /**
     * Beside the line that says nobody in the circle has rated places yet, when the person's scorer
     * was found with no ranks: whether its run is done, under way or failed is not known (ruling R10).
     * Signs in to Brainstorm if needed, and follows the run, or starts one.
     */
    workOutAgain: "Work out my circle again",
  },
  score: {
    /** On a card with no score, under the hours, when nobody has reviewed the place (SCREENS.md, wording patterns). */
    noReviewsYet: "No reviews yet",
    /** At the top right of a dashed card, where the rating would be: others have rated the place, the list's view has not (Main.dc.html). */
    noScoreYet: "No rating yet",
    /** A score as it is shown: "4.5", "4.0". */
    value: (n: number) => n.toLocaleString("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    /** The stars, for a screen reader: "4.5 out of 5". */
    starsLabel: (n: number) => `${n.toLocaleString("en", { maximumFractionDigits: 1 })} out of 5`,
    // DRAFT for Avi
    /** Under a scored place's hours, who its score comes from (Main.dc.html): "Rated by 3 people the house trusts". */
    ratedByHouse: (n: number) => `Rated by ${people(n)} ${houseTrusts}`,
    // DRAFT for Avi
    /** The same, in the place page's score panel (Place.dc.html): "From 3 people the house trusts". */
    fromHouse: (n: number) => `From ${people(n)} ${houseTrusts}`,
    // DRAFT for Avi
    /** A place with reviews, none by people inside House picks (Main.dc.html's dashed card): "2 other people have rated it". */
    othersRated: (n: number) => `${othersHave(n)} rated it`,
    // DRAFT for Avi
    /** A place with reviews while House picks can't be worked out: "2 people have rated it". */
    peopleRated: (n: number) => `${peopleHave(n)} rated it`,
    // DRAFT for Avi
    /** The same as `ratedByHouse`, while My circle is the view: "Rated by 3 people in your circle". */
    ratedByCircle: (n: number) => `Rated by ${people(n)} ${inYourCircle}`,
    // DRAFT for Avi
    /** The same as `fromHouse`, in the place page's score panel: "From 3 people in your circle". */
    fromCircle: (n: number) => `From ${people(n)} ${inYourCircle}`,
    // DRAFT for Avi
    /** In place of `ratedByCircle(1)` when the one person in the circle who rated the place is the person signed in. */
    ratedByYou: "Rated by you",
    // DRAFT for Avi
    /** In place of `fromCircle(1)`, in the place page's score panel, likewise. */
    fromYou: "From you",
    // DRAFT for Avi (ruling R13)
    /**
     * In place of `ratedByCircle(n + 1)` when the person signed in is one of those counted, beside `n`
     * others: "You and 2 other people in your circle".
     */
    ratedByYouAnd: (n: number) => `You and ${otherPeople(n)} ${inYourCircle}`,
    // DRAFT for Avi (ruling R13)
    /** In place of `fromCircle(n + 1)`, in the place page's score panel, likewise: "From you and 2 other people in your circle". */
    fromYouAnd: (n: number) => `From you and ${otherPeople(n)} ${inYourCircle}`,
    // DRAFT for Avi
    /**
     * A place with reviews, none by people in the person's circle, on a card or a row while My circle
     * is the view (the brief's § 5): "2 people outside your circle have rated it".
     */
    outsideCircle: (n: number) => `${people(n)} ${outsideYourCircle} ${n === 1 ? "has" : "have"} rated it`,
    // DRAFT for Avi
    /**
     * The same, first, in the place page's "No rating yet" panel, before how many others have rated it
     * (the brief's § 5: "No score yet. Nobody in your circle has been here yet. 11 other people have rated it.").
     */
    noneInCircle: "Nobody in your circle has rated it yet",
    /** The same as `starless`, while My circle is the view: "2 people in your circle wrote about it, no stars yet". */
    starlessCircle: (n: number) => `${people(n)} ${inYourCircle} wrote about it, no stars yet`,
    /**
     * The same as `houseUnavailable`, for My circle: its scorer's ranks can't be read. The same words
     * as `circle.unavailable`, which says the run that works the circle out failed.
     */
    circleUnavailable,
    // DRAFT for Avi
    /**
     * A place with no score that the person signed in has reviewed, in place of counting them among
     * the others ("1 other person has rated it"): never whether the house counts their review (ruling R15).
     */
    youRated: "You've rated it",
    /**
     * A place with reviews by people inside House picks, none of them with stars: no rating, and why.
     * "3 people the house trusts wrote about it, no stars yet".
     */
    starless: (n: number) => `${people(n)} ${houseTrusts} wrote about it, no stars yet`,
    /** A place with reviews whose reviewers are still being looked up: no rating yet, and nothing folded. */
    counting: "Loading reviews…",
    // DRAFT for Avi
    /** No review relay answered for a place: said quietly, on its card and its page (which offers Try again). */
    failed: "Reviews couldn't be loaded",
    /** One quiet line, when the house's view can't be read: every review is folded, and nothing is rated. */
    houseUnavailable: "House picks aren't available right now.",
  },
  /**
   * The reviews on a place's page (Place.dc.html, DeskPlace.dc.html), worded for House picks, and for
   * My circle where the words name the view.
   */
  reviews: {
    // DRAFT for Avi
    /** A reviewer whose profile gives no name, or none that can be shown (Review Focus 4): never a code. */
    someone: "Someone",
    // DRAFT for Avi
    /** The heading over the reviews by people inside House picks (the design's "From your circle"). */
    heading: "Rated by people the house trusts",
    // DRAFT for Avi
    /** The same, while My circle is the view. */
    headingCircle: "Rated by people in your circle",
    // DRAFT for Avi
    /** The box of reviews from outside House picks, under the ones inside: "4 more reviews from outside House picks". */
    foldedMore: (n: number) => `${n.toLocaleString("en")} more ${n === 1 ? "review" : "reviews"} from outside House picks`,
    // DRAFT for Avi
    /** The same box when no review is inside House picks: "4 reviews from outside House picks". */
    foldedAll: (n: number) => `${reviewCount(n)} from outside House picks`,
    // DRAFT for Avi
    /** The box of reviews from outside the person's circle, while My circle is the view: "4 more reviews from outside your circle". */
    foldedMoreCircle: (n: number) => `${n.toLocaleString("en")} more ${n === 1 ? "review" : "reviews"} from ${outsideYourCircle}`,
    // DRAFT for Avi
    /** The same box when no review is inside the circle: "4 reviews from outside your circle". */
    foldedAllCircle: (n: number) => `${reviewCount(n)} from ${outsideYourCircle}`,
    // DRAFT for Avi
    /**
     * The same box while the view can't be worked out (its ranks can't be read), with every review in
     * it and no rating on the page: "2 reviews, shown without a rating for now".
     */
    uncounted: (n: number) => `${reviewCount(n)}, shown without a rating for now`,
    /** Under it: the folded reviews are not a verdict on the people who wrote them (Avi, 2026-10-09). */
    foldedNote: "Folded away, never deleted.",
    /** The button that opens the folded reviews, and closes them again. */
    show: "Show them",
    // DRAFT for Avi
    /**
     * The heading over the review of the person signed in, on its own at the top of the place's
     * reviews, whether the house counts it or not, which nothing here says (ruling R15).
     */
    yours: "Your review",
    // DRAFT for Avi
    /** Under it: opens the review form, filled in with it. */
    edit: "Edit",
    // DRAFT for Avi
    /** Under it: asks whether to remove it (`removeQuestion`). */
    remove: "Remove",
    /** What Remove asks, with the two buttons below (Avi, 2026-10-09). */
    removeQuestion: "Remove your review? It comes off Regulars and everywhere else it was posted.",
    // DRAFT for Avi
    /** The button that removes it, once asked. */
    removeConfirm: "Remove",
    // DRAFT for Avi
    /** The button that leaves it as it is. */
    keep: "Keep it",
    // DRAFT for Avi
    /** The button while it is being removed, and said politely to a screen reader. */
    removing: "Removing…",
    // DRAFT for Avi
    /**
     * Under the button, said politely, while Regulars has not taken the removal 8 seconds after it was
     * sent (ruling P1): it is still trying, and the button still says Removing… (a state the design does not draw).
     */
    stillRemoving: "Still removing. Regulars is slow to answer right now.",
    // DRAFT for Avi
    /** Said politely to a screen reader once it is removed (the section goes, a state the design does not draw). */
    removed: "Your review is removed.",
    // DRAFT for Avi
    /** No review relay took the removal: the review stays, and says so (a state the design does not draw). */
    removeFailed: "Your review didn't come off. Try again.",
    /**
     * Only the person's own relays took the removal, not the ones Regulars reads reviews from (ruling
     * R17): it is gone from their account, and still on Regulars. There is no keeping it then (Avi, 2026-10-09).
     */
    removePartial: "Removed from your account, but not from Regulars yet. Try again.",
    // DRAFT for Avi
    /** The button that removes it again, after either. */
    removeAgain: "Try again",
    // DRAFT for Avi
    /**
     * When a review was written, from how many calendar days and whole calendar months ago:
     * "Today", "Yesterday", "3 days ago", "a week ago", "2 weeks ago", "a month ago", "11 months ago",
     * and "a year ago" once a full year has passed.
     */
    when: (days: number, months: number) => {
      if (days <= 0) return "Today";
      if (days === 1) return "Yesterday";
      if (days < 7) return ago(days, "day");
      if (days < 30) return ago(Math.floor(days / 7), "week");
      if (months < 12) return ago(Math.max(1, months), "month");
      return ago(Math.floor(months / 12), "year");
    },
  },
  /**
   * Trending (Avi, 2026-10-08; named Recent until decision 31): the newest reviews of places everywhere,
   * from the people who count in the view on screen, newest first. Each is a link to its place. The
   * keys keep the name the list had.
   */
  recent: {
    // DRAFT for Avi
    /** Under the toggle while it is on House picks: what the list is, and whose reviews these are. */
    houseLine: "The newest reviews from the reviewers the house trusts.",
    // DRAFT for Avi
    /** The same, while it is on My circle. */
    circleLine: "The newest reviews from your circle.",
    // DRAFT for Avi
    /** In place of the name on the person's own review. */
    you: "You",
    // DRAFT for Avi
    /**
     * How long ago a review was written, in plain words, from how many seconds, calendar days and whole
     * calendar months ago: "now", "5 minutes ago", "2 hours ago" under a day, then "yesterday", "3 days
     * ago", "1 week ago", "2 months ago", "1 year ago".
     */
    when: (seconds: number, days = 0, months = 0) => {
      if (seconds < 60) return relativeWords.format(0, "second");
      if (seconds < 3_600) return relativeCount.format(-Math.floor(seconds / 60), "minute");
      if (seconds < 86_400) return relativeCount.format(-Math.floor(seconds / 3_600), "hour");
      if (days < 2) return relativeWords.format(-1, "day");
      if (days < 7) return relativeCount.format(-days, "day");
      if (days < 30) return relativeCount.format(-Math.floor(days / 7), "week");
      if (months < 12) return relativeCount.format(-Math.max(1, months), "month");
      return relativeCount.format(-Math.floor(months / 12), "year");
    },
    // DRAFT for Avi
    /** A review in the list, for a screen reader: the link to its place. "Maya's review of Jacafé, 2 hours ago". */
    entry: (name: string, place: string, when: string) => `${name}'s review of ${place}, ${when}`,
    // DRAFT for Avi
    /** The same, for the person's own: "Your review of Jacafé, now". */
    yourEntry: (place: string, when: string) => `Your review of ${place}, ${when}`,
    // DRAFT for Avi
    /** While the newest reviews are read, or whose they are is worked out. */
    loading: "Reading the latest reviews…",
    // DRAFT for Avi
    /** No review relay answered for the newest reviews, with Try again (`load.retry`). */
    failed: "The latest reviews couldn't be loaded.",
    // DRAFT for Avi
    /** The same, for the newest page read again over a list on screen, which stays. */
    newerFailed: "The newest reviews couldn't be loaded.",
    // DRAFT for Avi
    /** The button under the list that reads the next reviews back in time. */
    showOlder: "Show older reviews",
    // DRAFT for Avi
    /** Beside it, when they could not be read: it reads them again. */
    olderFailed: "Older reviews couldn't be loaded.",
    // DRAFT for Avi
    /** Under the list, once every review there is has been read. */
    end: "That's every review so far.",
    // DRAFT for Avi
    /** In place of the list, in House picks, once every review is read and none counts. */
    emptyHouse: "No reviews from the reviewers the house trusts yet.",
    // DRAFT for Avi
    /** The same, in My circle. The switch to House picks (`toHouse`) follows. */
    emptyCircle: "Nobody in your circle has reviewed a place yet.",
    // DRAFT for Avi
    /** In place of the list, in House picks, when none of the reviews read counts and there are older ones to read. */
    noneLatestHouse: "None of the latest reviews are from the reviewers the house trusts.",
    // DRAFT for Avi
    /** The same, in My circle. */
    noneLatestCircle: "None of the latest reviews are from your circle.",
    // DRAFT for Avi
    /** Under the empty list in My circle: switches the view to House picks. */
    toHouse: "Show House picks",
  },
  /**
   * Where the map and the place details come from. `mapTiler` and `openStreetMap` are the words in
   * those lines that link to each source's terms.
   */
  attribution: {
    map: "© MapTiler © OpenStreetMap contributors",
    details: "Place details © OpenStreetMap contributors, via BTC Map",
    mapTiler: "MapTiler",
    openStreetMap: "OpenStreetMap contributors",
  },
  /** How the places loaded. */
  load: {
    /** The places shown are the ones saved on this device: the latest could not be loaded. */
    cached: "Showing places saved on this device",
    // DRAFT for Avi
    /** No places could be loaded, and none were saved on this device. */
    failed: "We couldn't load places. Check your connection and try again.",
    retry: "Try again",
    // DRAFT for Avi
    /** The first visit, while the places load. */
    loading: "Finding places…",
    // DRAFT for Avi
    /** The browser says it has no connection, and there are no places on this device to show. */
    offline: "You're offline. Places will load when you're back online.",
  },
  // DRAFT for Avi
  /** The browser says it has no connection, and the places on screen are the ones saved on this device. */
  offline: "You're offline. Showing places saved on this device.",
  // DRAFT for Avi
  /** The browser says it has no connection, and the places did not come from the device's saved copy. */
  offlineNoCache: "You're offline.",
  pages,
  // DRAFT for Avi
  /** An address in the app that has no page. */
  missing: {
    text: "We can't find that page.",
    home: backToExplore,
  },
  // DRAFT for Avi
  /** A page that broke while it was drawn. */
  broken: {
    text: "Something went wrong on this page.",
    home: backToExplore,
  },
  /** The title of each page in the browser's tab. Explore is the app's name; the rest put theirs before it. */
  titles: {
    explore: config.appName,
    map: pageTitle(pages.map),
    search: pageTitle(pages.search),
    filters: pageTitle(pages.filters),
    /** A place's page is named after the place: "Jacafé · Regulars". */
    place: (name: string) => pageTitle(name),
    // DRAFT for Avi
    /** The page of a place that is not on the list any more. */
    notListed: pageTitle("No longer listed"),
    /** A chain's page is named after the chain: "A Confeitaria Coffee & Bakery · Regulars". */
    chain: (name: string) => pageTitle(name),
    about: pageTitle(pages.about),
    signin: pageTitle(pages.signin),
    saved: pageTitle(pages.saved),
    you: pageTitle(pages.you),
    recent: pageTitle(pages.recent),
    // DRAFT for Avi
    missing: pageTitle("Not found"),
    // DRAFT for Avi
    /** The review form is named after the place it reviews: "Your review of Jacafé · Regulars". */
    review: (name: string) => pageTitle(`${yourReviewOf} ${name}`),
    why: pageTitle(whyTitle),
  },
  /** The sign-in page (SignIn.dc.html, DeskSignIn.dc.html), and the button that leads to it. */
  signin: {
    /** The button on the pages that need a person (Saved, You). */
    button: pages.signin,
    continueButton: ALLOWED_PROTOCOL_STRINGS.signInButton,
    // DRAFT for Avi: shown under the button while signing in is not open.
    comingSoon: "Signing in opens soon. Everything else works without it.",
    /** The cross at the top right, for a screen reader. */
    close: "Close",
    headline: "Ratings from people you'd actually ask.",
    intro:
      "Right now you're seeing House picks. Sign in and every rating is worked out from the people you trust, and the people they trust.",
    /** The three steps. SignIn.dc.html's first step says "follow", which nothing in the app may; DeskSignIn.dc.html says "trust". */
    steps: [
      "Sign in. We read who you already trust.",
      "We work out your circle. It takes a few minutes, in the background.",
      "Switch between House picks and My circle whenever you like.",
    ],
    /** The second button: go back to where the person was, with the house's scores. */
    keepHousePicks: "Keep House picks",
    // DRAFT for Avi: its second sentence, which said "scores" of the circle Brainstorm works out.
    /** The notice about what personalizing does (the brief, section 6). */
    notice: "Nothing is posted without you. Your circle is worked out by our scoring partner, and it is public.",
    howItWorks: "First time? How signing in works",
    // DRAFT for Avi
    /** The numbered list of steps, for a screen reader. */
    stepsLabel: "The three steps",
    // DRAFT for Avi: from here to `cancel`, what Continue opens (decision 23).
    /**
     * Under Continue where the browser has an add-on, which Continue asks at once: the phone's way
     * instead. And beside Try again when the add-on said no, there and where the person signed in
     * from (Rate this place, the account button).
     */
    phoneInstead: "Use an app on your phone instead",
    /** While the page looks, for a moment, for an add-on that comes late, before Continue goes one way or the other. */
    lookingForAddOn: "Looking for your add-on…",
    /** Under the phone's way, on a desktop whose browser has no add-on to sign in with. */
    noAddOn: "To sign in with this browser, add a sign-in add-on to it, then reload this page.",
    /** While the browser's add-on asks the person. */
    browserWaiting: `Your browser add-on will ask you to allow ${config.appName}.`,
    /** The same, in a line under Rate this place or the account button, which sign the person in where they are. */
    waitingForAddOn: "Waiting for your add-on…",
    /** The add-on said no, or failed: said with Try again, which asks it again, and the phone's way. */
    addOnFailed: "That didn't work. Try again, or use an app on your phone.",
    /** Beside them, where the person signed in from Rate this place or the account button: puts the line away. */
    dismiss: "Dismiss",
    /** Over the code to scan. */
    scan: "Scan this with the app, or copy the link",
    /** The code to scan, for a screen reader. */
    qrLabel: "Code to scan with the app on your phone",
    copyLink: "Copy the link",
    /** On a phone, beside the code: opens the app on the same phone with the link. */
    openApp: "Open the app",
    /** Said once the link is copied. */
    copied: "Link copied",
    /** Said when the browser would not copy it. */
    notCopied: "The link didn't copy. Scan the code, or paste a link from your app.",
    /** The field for a link the phone app gives, to paste here. */
    paste: "Paste a link from your app",
    /** The button that connects with the pasted link. */
    connect: "Connect",
    /** While it connects with the pasted link. */
    connecting: "Connecting…",
    /** The phone app did not answer in time, said no, or stopped half-way (Review Focus 3); or the phone's way could not be fetched. */
    failed: "That didn't connect. Try again.",
    tryAgain: "Try again",
    /** Stops waiting, on the add-on or the phone app, and gives Continue (or what was pressed) back. */
    cancel: "Cancel",
  },
  /** The pages that need a person (Saved and You). The design draws neither signed out. */
  saved: {
    // DRAFT for Avi
    signedOut: "Sign in to save places and make lists you can share.",
    // DRAFT for Avi
    /** Saved after sign in, before saving opens. */
    soon: "Saving places and lists opens soon.",
  },
  you: {
    // DRAFT for Avi
    signedOut: "Sign in to see your reviews and the people you trust.",
    // DRAFT for Avi
    signOut: "Sign out",
  },
  /**
   * Why you see what you see (the brief's screen 12 and D4; Trust.dc.html, DeskTrust.dc.html): how a
   * score is worked out, the person's circle in a count (a count of people, never a number on one:
   * decision 19), and Update now. The people the person trusts, each with Remove, come with the Trust
   * button (the brief's § 7), not here.
   */
  why: {
    title: whyTitle,
    intro: "There is no single rating for a place. Every rating here is worked out from a set of people. You choose which set.",
    /** Over the toggle. */
    lookingThrough: "You're looking through",
    // DRAFT for Avi
    /** The name of the panel with the circle's count (and of the desktop's side rail), for a screen reader. */
    circleHeading: "Your circle",
    // DRAFT for Avi: the signed-out version is not drawn. Signed out, the panel has the sign-in page's
    // words (`signin.intro`) and Sign in; signed in, before the circle is worked out, these and Personalize.
    housePicksNow:
      "Right now you're seeing House picks. My circle works out every rating from the people you trust, and the people they trust.",
    /** The big number: how many people are in the circle, "212". */
    count: (n: number) => n.toLocaleString("en"),
    // DRAFT for Avi
    /** The same, when only a floor is known: "2,400+". */
    countAtLeast: (n: number) => `${n.toLocaleString("en")}+`,
    /** Beside the big number. */
    inYourCircle: (n: number) => (n === 1 ? "person in your circle" : "people in your circle"),
    // DRAFT for Avi
    /** The floor and its words, for a screen reader: "At least 2,400 people in your circle". */
    atLeast: (n: number) => `At least ${people(n)} in your circle`,
    /** The circle, split: the people the person trusts, and the people those people trust. */
    youTrust: "People you trust",
    theyTrust: "People they trust",
    // DRAFT for Avi: "today" and "yesterday" (the design draws "Worked out 2 days ago").
    /** When the circle was worked out: "Worked out 2 days ago". */
    workedOut: (days: number, months: number) => {
      let when: string;
      if (days <= 0) when = "today";
      else if (days === 1) when = "yesterday";
      else if (days < 7) when = ago(days, "day");
      else if (days < 30) when = ago(Math.floor(days / 7), "week");
      else if (months < 12) when = ago(Math.max(1, months), "month");
      else when = ago(Math.floor(months / 12), "year");
      return `Worked out ${when}`;
    },
    // DRAFT for Avi
    /** While the circle is counted. */
    counting: "Counting your circle…",
    // DRAFT for Avi
    /** The circle could not be counted (its scores could not be read). Try again follows. */
    countFailed: "Your circle can't be counted right now.",
    // DRAFT for Avi: the brief's § 6 says to say plainly when the circle is empty.
    /** The circle is ready, and nobody is in it but the person. */
    emptyTitle: "Nobody in your circle yet",
    // DRAFT for Avi
    emptyBody:
      "Your circle is the people you trust and the people they trust, and so far that's nobody. Until it grows, My circle counts only your own reviews, and House picks still has ratings for you.",
    updateNow: "Update now",
    // DRAFT for Avi
    /** After Update now, while Brainstorm works the circle out again. Scores use the circle the person has meanwhile. */
    updating: "Updating your circle. This takes a few minutes.",
    // DRAFT for Avi
    /**
     * Brainstorm is working it out again, and the page can no longer follow it (its sign-in ran out):
     * scores use the new circle from the person's next visit, when its ranks are read afresh.
     */
    updateStarted: "Your circle is still being worked out. We'll use the new one on your next visit.",
    // DRAFT for Avi
    /** Brainstorm has worked it out again: beside Update now, or in the bar once the person has left this page. */
    updated: "Your circle is up to date.",
    // DRAFT for Avi
    /** The run failed, took too long, or Brainstorm could not be reached. */
    updateFailed: "Your circle couldn't be updated right now. Ratings still use the one you have.",
    rulesHeading: "How a rating is worked out",
    /** The three rules: on a phone, each title is a sentence before its words; on a desktop, a card's heading. */
    rules: {
      only: { title: "Only your circle counts", body: "A review from someone outside it doesn't move the rating you see at all." },
      closer: { title: "Closer people count for more", body: "Someone you trust outweighs someone a friend of a friend trusts." },
      oneSay: { title: "One say each", body: "A person has one review per place. Writing another replaces it." },
    },
    foldedHeading: "What gets folded away",
    // DRAFT for Avi: the design's words, but for its last sentence ("Trust a reviewer and theirs count
    // from the next update."), which points at the Trust button, not built yet (ruling R11). People
    // trust others in the apps they use today.
    /** On a phone (Trust.dc.html). */
    foldedBody:
      "Reviews from people outside your circle sit folded under each place. Nothing is deleted, and one tap opens them. If you trust someone new in another app, their reviews count here from your circle's next update.",
    /** On a desktop (DeskTrust.dc.html): a click, not a tap. */
    foldedBodyDesk:
      "Reviews from people outside your circle sit folded under each place. Nothing is deleted, and one click opens them. If you trust someone new in another app, their reviews count here from your circle's next update.",
    houseHeading: "And House picks?",
    /** On a phone (Trust.dc.html). */
    houseBody: `The same sums from a different starting point: the reviewers that ${houseName}, our house curator, trusts. It's what everyone sees before signing in, and it's always one tap away.`,
    /** On a desktop (DeskTrust.dc.html), where the toggle is in the top bar too. */
    houseBodyDesk: `The same sums from a different starting point: the reviewers that ${houseName}, our house curator, trusts. It's what everyone sees before signing in.`,
    /** The link at the foot. */
    about: `About ${config.appName} and its data`,
  },
  /** About and data (About.dc.html). */
  about: {
    /** The arrow at the top left, for a screen reader, when the page was opened from another one. */
    back: "Back",
    title: "Places to eat and drink, rated by people you'd actually ask.",
    // DRAFT for Avi
    /** The desktop's side rail, for a screen reader. */
    railLabel: "The data in numbers",
    placesHeading: "Where the places come from",
    placesBody: "Names, addresses, hours and locations come from OpenStreetMap, the free map built by volunteers.",
    /** The figures of the data, each a label and its value. The values are worked out from the places; none is written here. */
    figures: {
      places: "Places",
      countries: "Countries",
      lastRefreshed: "Last refreshed",
      refreshed: "Refreshed",
      monthly: "Every month",
      // DRAFT for Avi
      /** In place of a figure while the places have not loaded. */
      none: "—",
    },
    /** Where the details come from: the one place in the app that names BTC Map, in fine print (decisions.md #7). */
    source: "Place details from OpenStreetMap, gathered for us by BTC Map",
    licence: "© OpenStreetMap contributors. Place data is available under the Open Database Licence.",
    // DRAFT for Avi
    /** Where the towns' names come from (src/data/towns.json), in fine print, as `source` is. */
    townsSource: "Town names adapted from GeoNames (geonames.org), CC BY 4.0.",
    // DRAFT for Avi
    /** The link to the terms of that licence, under the link to OpenStreetMap's. */
    townsLicenceLink: "Town names licence",
    licenceLink: "Licence and copyright",
    // DRAFT for Avi
    /** The link to the licences of the software the site is built from (a text file the build writes). */
    softwareLicences: "Software licences",
    reviewsHeading: "Where the reviews come from",
    reviewsBody:
      "People write them under their own names. Nobody at Regulars edits or reorders them. The rating you see for a place is worked out from the reviewers you trust, so two people can see different ratings for the same place.",
    // DRAFT for Avi: the two views in plain words, where House picks are said once. The design links to a "How scores are worked out" page, which is for people who have signed in.
    viewsBody:
      "House picks are the ratings from the reviewers that the house trusts, and everyone starts there. My circle is the same, worked out from the people you trust and the people they trust. You can switch between them whenever you like.",
    houseHeading: "Who the house is",
    // DRAFT for Avi: the design's sentence says what House picks are, which the section above now does.
    houseBody:
      `${houseName}, our house curator, is the house. It trusts the reviewers behind House picks, and it also keeps the list of places up to date.`,
    signingInHeading: "How signing in works",
    signingInBody:
      "You sign in with an account you hold yourself, through a sign-in app in your browser or on your phone. Regulars never sees a password, and nothing is posted unless you press Post.",
    yoursHeading: "Your reviews are yours",
    yoursBody:
      "Places, reviews and lists are public records that don't live inside this app. Other apps can read the same ones, and yours stay with you if you leave.",
  },
  /**
   * Writing a review (Review.dc.html; DeskReview.dc.html, a dialog over the place's page), every
   * string as Avi approved it (2026-10-09). The tags the design draws ("Anything worth flagging?") are
   * left out while tags are off (brief § 4.4).
   */
  review: {
    /** The dialog on a desktop, for a screen reader (DeskReview.dc.html). */
    dialogLabel: "Write a review",
    /** At the top, who the review will carry the name of (the design's). */
    reviewingAs: (name: string) => `Reviewing as ${name}`,
    /** Over the place's name (the design's). */
    yourReviewOf,
    /** Over the stars (the design's). */
    howWasIt: "How was it?",
    /** The word under the stars for each number of them, from one to five (the design's). */
    starWords: [...starWords],
    /** A star button, for a screen reader: how many stars, and their word. "4 stars, Good". */
    star: (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "star" : "stars"}, ${starWords[n - 1] ?? ""}`,
    /** The text box's label (the design's). */
    textLabel: "What should a friend know?",
    /** In the empty text box (the design's). */
    textPlaceholder: "What to order, when to go, what to skip.",
    /** Under the text box (the design's). */
    textHint: "Optional. A rating on its own still counts.",
    /** Over Post (Avi, 2026-10-09). */
    notice: "Reviews are public and carry your name. Posting again replaces your review; you can remove it later.",
    /** The button that posts it (the design's). */
    post: "Post review",
    /** The same button while the review is being posted. */
    posting: "Posting…",
    /**
     * Under the button, said politely, while Regulars has not taken the review 8 seconds after it was
     * sent (ruling P1): it is still trying, and the button still says Posting… (a state the design does not draw).
     */
    stillPosting: "Still posting. Regulars is slow to answer right now.",
    /** No relay took the review, or there was nowhere to send it; what was typed stays (a state the design does not draw). */
    failed: "Your review didn't post. Try again.",
    /**
     * Only the person's own relays took the review, not the ones Regulars reads reviews from (ruling
     * R13): it is in their account, and not on Regulars. What was typed stays (Avi, 2026-10-09).
     */
    notOnRegulars: "Saved to your account, but not to Regulars yet. Try again.",
    /** Post, once a post has failed: it posts again. */
    tryAgain: "Try again",
    /** The arrow at the top left of the phone's form, for a screen reader: back to the place. */
    back: "Back",
    /** The cross at the top right of the desktop's dialog, for a screen reader. */
    close: "Close",
  },
  /** A place's page (Place.dc.html, PlaceNew.dc.html, DeskPlace.dc.html). */
  place: {
    /** The arrow at the top left, for a screen reader, and the link above the page on a desktop, when it goes back the way the person came. */
    back: "Back to results",
    /** The same, when the place was the first page opened: it goes to Explore. */
    backHome: backToExplore,
    /** The bookmark at the top right, for a screen reader. */
    save: "Save this place to a list",
    /** The same, in words, among the desktop's buttons (DeskPlace.dc.html). */
    saveShort: "Save",
    /** Under the name: what it is and how far: "Coffee shop · 0.4 mi away". */
    kindAway: (kind: string, distance: string) => (distance === "" ? kind : `${kind}${dot}${distance} away`),
    /** The dashed panel where the score goes, before anyone has reviewed the place (PlaceNew.dc.html). */
    beFirst: "Be the first in your circle",
    nobodyYet: (name: string) => `Nobody has reviewed ${name} yet. Yours is the one the people who trust you will see.`,
    rate: "Rate this place",
    /**
     * The buttons under it: directions, a call, the website (Avi, 2026-10-09). Directions, beside the
     * others, is "Get directions" to a screen reader; on its own, it says so to the eye too.
     */
    go: "Directions",
    directions: "Get directions",
    call: "Call",
    site: "Website",
    /** The labels of the facts. */
    facts: { address: "Address", hours: "Hours", phone: "Phone", payment: "Payment" },
    /** The hours fact, for a place with none (PlaceNew.dc.html). */
    hoursNotListed: "Not listed",
    /**
     * What the place lacks, asked for (PlaceNew.dc.html): "No phone, website or hours listed. Know
     * them?" A link, `suggestFix`, follows it. Nothing when it lacks none.
     */
    missingDetails: (phone: boolean, website: boolean, hours: boolean) => {
      const missing = (["phone", "website", "hours"] as const).filter((_, i) => [phone, website, hours][i]);
      if (missing.length === 0) return "";
      const plural = missing.length > 1 || hours;
      return `No ${eitherOf(missing)} listed. Know ${plural ? "them" : "it"}?`;
    },
    suggestFix: "Suggest a fix",
    /** At the foot of the page, a link to say what is wrong with the details. */
    somethingWrong: "Something wrong? Suggest a fix",
    // DRAFT for Avi
    /** At the foot of the page, a link to the place's own record. */
    viewOnOsm: "View on OpenStreetMap",
    // DRAFT for Avi
    /** The map of the place, for a screen reader: the name of the map's region. */
    mapLabel: (name: string) => `Map showing where ${name} is`,
    // DRAFT for Avi
    /**
     * At the map's top left, once the person has moved the map: takes it back to the place's pin. The
     * words in the desktop's rail; on a phone, the name of the icon that stands for them.
     */
    mapBack: "Back to the place",
    // DRAFT for Avi
    /** The desktop's side rail (DeskPlace.dc.html), for a screen reader. */
    railLabel: "Details and directions",
    /** The places closest to this one, each with its own score from House picks: not "Nearby, rated by your circle". */
    nearby: "Nearby",
    /** How far a place nearby is from this one: "0.3 mi from here". */
    fromHere: (distance: string) => `${distance} from here`,
    /** A place that was on the list and is not now (the brief, screen 13). */
    noLongerListed: "No longer listed.",
    noLongerListedDetail: "It came off the map at the last monthly refresh.",
    backToExplore,
    bitcoinChip: ALLOWED_PROTOCOL_STRINGS.bitcoinChip,
  },
  hours: {
    /** A time of day goes in `time`: "11 pm" or "23:00", and "Tue 11 am" when it is more than a day away. */
    openUntil: (time: string) => `Open until ${time}`,
    openNowCloses: (time: string) => `Open now${dot}closes ${time}`,
    closedOpens: (time: string) => `Closed${dot}opens ${time}`,
    /** The same two inside a line that dots join already, on the desktop's place page (DeskPlace.dc.html). */
    inlineJoiner: comma,
    openNowClosesInline: (time: string) => `Open now${comma}closes ${time}`,
    closedOpensInline: (time: string) => `Closed${comma}opens ${time}`,
    /** The words of an open place that closes within 45 minutes, before its closing time (Avi, 2026-10-09). */
    closingSoonWords: "Closing soon",
    /** Such a place's line, on a card, a row and the place page: "Closing soon · 4 pm". */
    closingSoon: (time: string) => `Closing soon${dot}${time}`,
    /** The same inside a line that dots join already, on the desktop's place page: "Closing soon, 4 pm". */
    closingSoonInline: (time: string) => `Closing soon${comma}${time}`,
    open24: "Open 24 hours",
    closed: "Closed",
    notListed: "Hours not listed",
    /** The two halves of the day on a 12-hour clock. */
    am: "am",
    pm: "pm",
    /** Monday first. The weekday before a time that is more than a day away: "Closed · opens Mon 9 am". */
    weekdaysShort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    /** One opening in a day of the week's hours, as Place.dc.html words it: "9:30 am to 5:30 pm". */
    range: (from: string, to: string) => `${from} to ${to}`,
    /** The end of an opening that closes as the day ends: "11 am to midnight". */
    midnight: "midnight",
  },
  explore: {
    // DRAFT for Avi
    /** The control at the top of the page. `label` is where the places are near: "Funchal", or "you". */
    near: nearLabel,
    /**
     * Under the toggle, while it is on House picks (Main.dc.html), with the house's badge before its
     * name. "How this works" follows it, as a link.
     */
    houseLine: `Ratings from reviewers our house curator, ${houseName}, trusts.`,
    /** The same, while it is on My circle. "How this works" follows it, as a link. */
    circleLine: "Ratings from your circle: the people you trust, and the people they trust.",
    /**
     * Under that, while My circle is the view and nobody in the person's circle has rated any place
     * they have seen this session (a circle of one: the brief's § 6, rulings R7 and R8). The toggle
     * above keeps House picks one tap away; nothing switches the view for them.
     */
    circleEmpty: "Nobody in your circle has rated places yet. House picks still has ratings for you.",
    /** The same, when the person signed in has rated places, and nobody else in their circle has (ruling R8). */
    circleOnlyYou: "Only you have rated places in your circle so far. House picks still has ratings for you.",
    howThisWorks: "How this works",
    /** The filter chips, for a screen reader. */
    filtersLabel: "Filter places",
    /** The chips. Restaurants and Cafes are the kind families' own names. */
    chips: { all: "All", open: "Open now", more: "More" },
    /** What a place is and how far it is: "Mexican restaurant · 1.1 mi". */
    kindLine: (kind: string, distance: string) => (distance === "" ? kind : `${kind}${dot}${distance}`),
    chainKind,
    // DRAFT for Avi
    /**
     * How many of a chain's locations are near the "Near …" place, and how far the closest is from it
     * (Main.dc.html, without its "near you"): "12 nearby, the closest 0.4 mi away". The line above it
     * has the chain's total ("Bakery · 74 locations").
     */
    chainNearby: (n: number, distance: string) => `${n.toLocaleString("en")} nearby, the closest ${distance} away`,
    /** The button after the last card shown, when there are more. */
    showMore: "Show more",
    // DRAFT for Avi
    /** No place is listed around the point. `label` is where that is: "Funchal", or "you". */
    noneNearby: (label: string) => `No places listed near ${label} yet. Try another town.`,
    // DRAFT for Avi
    /** The button under that, which opens the list of towns. */
    chooseTown: "Choose a town",
    // DRAFT for Avi
    /** Places are near, and the chip on screen leaves none of them. */
    noneMatching: "No places here match that.",
    // DRAFT for Avi
    /** The button under that, which clears the chip. */
    showAll: "Show all places",
  },
  /** A chain's page (Chain.dc.html): the places that share a name, and which of them are near. */
  chain: {
    /**
     * Under the chain's name (Chain.dc.html): what it is, how many places have its name and how many
     * are near `near` (`nearCount`): "Coffee shop · 74 locations · 3 near Funchal".
     */
    line: (kind: string, n: number, nearby: number, near: string) => `${chainKind(kind, n)}${dot}${nearCount(nearby, near)}`,
    // DRAFT for Avi: "none near Funchal" is not drawn; the design has a chain with three near.
    nearCount,
    eachScored: "Each location is rated on its own",
    eachScoredDetail: "A good one here says little about the one across town.",
    // DRAFT for Avi
    /**
     * After it, when two or more locations near `near` have ratings (Chain.dc.html, worded for House
     * picks): the lowest and the highest. "Near Funchal, the house rates them from 3.6 to 4.4."
     */
    houseRange: (low: string, high: string, near: string) =>
      low === high ? `${nearLabel(near)}, the house rates them ${low}.` : `${nearLabel(near)}, the house rates them from ${low} to ${high}.`,
    // DRAFT for Avi
    /** The same, when one location near has a rating. */
    houseOne: (score: string, near: string) => `${nearLabel(near)}, the house rates one ${score}.`,
    // DRAFT for Avi
    /** The same as `houseRange`, while My circle is the view. */
    circleRange: (low: string, high: string, near: string) =>
      low === high
        ? `${nearLabel(near)}, your circle rates them ${low}.`
        : `${nearLabel(near)}, your circle rates them from ${low} to ${high}.`,
    // DRAFT for Avi
    /** The same as `houseOne`, while My circle is the view. */
    circleOne: (score: string, near: string) => `${nearLabel(near)}, your circle rates one ${score}.`,
    /** The heading over the locations that are near, as the "Near …" control names where: "Near Funchal", "Near you". */
    near: nearLabel,
    // DRAFT for Avi: the heading over the nearest three, when none is near.
    nearest: "Nearest locations",
    /** The link beside the heading "Near …", on a phone, to the map. */
    seeOnMap: "See on map",
    /** The button under the locations that are near, when the chain has more (Chain.dc.html): "Show all 74 locations". */
    showAll: (n: number) => `Show all ${locations(n)}`,
    // DRAFT for Avi: the page lists at most this many, so the button for a chain with more says it shows the nearest.
    showNearest: (n: number) => `Show the nearest ${n.toLocaleString("en")}`,
    // DRAFT for Avi: the design adds "Not the same business? Tell us", a link to a form this version does not have.
    grouped: "Places with the same name are grouped.",
    // DRAFT for Avi
    /** The map of the locations, which does not move, as one picture for a screen reader. */
    mapLabel: (name: string) => `Map showing the nearest ${name} locations`,
    // DRAFT for Avi
    /** The desktop's side rail, for a screen reader. */
    railLabel: "Map and where the details come from",
  },
  /** The map (Map.dc.html, DeskExplore.dc.html). */
  map: {
    /** The map itself, for a screen reader. */
    label: "Map",
    /**
     * A place's pin, for a screen reader: its name, what it is and its hours, then its score, as the
     * pill says it to the eye, or what the ring stands for: "Dose, Cafe, Open until 6 pm, no reviews yet".
     */
    placePin: (name: string, kind: string, hours: string, score?: string) =>
      score === undefined ? `${name}, ${kind}, ${hours}` : `${name}, ${kind}, ${hours}, ${score}`,
    /** The score part of the pin of a place nobody has reviewed, which the ring says to the eye. */
    unrated: "no reviews yet",
    // DRAFT for Avi
    /** The score part of a scored place's pin: "4.6 out of 5, rated by 3 people the house trusts". */
    pinScored: (score: string, n: number) => `${score} out of 5, rated by ${people(n)} ${houseTrusts}`,
    // DRAFT for Avi
    /** The same, while My circle is the view: "4.6 out of 5, rated by 3 people in your circle". */
    pinScoredCircle: (score: string, n: number) => `${score} out of 5, rated by ${people(n)} ${inYourCircle}`,
    // DRAFT for Avi
    /** The same, when the one person in the circle who rated it is the person signed in: "4.0 out of 5, rated by you". */
    pinScoredYou: (score: string) => `${score} out of 5, rated by you`,
    // DRAFT for Avi (ruling R13)
    /** The same, when the person signed in is one of those counted, beside `n` others: "4.3 out of 5, rated by you and 2 other people in your circle". */
    pinScoredYouAnd: (score: string, n: number) => `${score} out of 5, rated by you and ${otherPeople(n)} ${inYourCircle}`,
    // DRAFT for Avi: in the words Avi approved for the line under a card's hours (`score.counting`).
    /** The same, for a place whose reviews are being counted. */
    pinCounting: "loading reviews",
    // DRAFT for Avi
    /** The same, for a place with reviews and no score. */
    pinNoScore: "no rating yet",
    // DRAFT for Avi
    /** The same, for a place whose reviews couldn't be loaded. */
    pinFailed: "reviews couldn't be loaded",
    /** A chain's one pin, for a screen reader: "Copper Kettle Coffee, a chain, 3 locations nearby". */
    chainPin: (name: string, n: number) => `${name}, a chain, ${n.toLocaleString("en")} locations nearby`,
    /** What a chain's pin says beside its icon: "×3". */
    chainCount: (n: number) => `×${n.toLocaleString("en")}`,
    /** A bubble of pins too close to tell apart, for a screen reader (Map.dc.html): "12 places here, zoom in". */
    cluster: (n: number) => `${n.toLocaleString("en")} places here, zoom in`,
    /** The button that lists the places where the person has moved the map to. */
    searchArea: "Search this area",
    youAreHere: "You are here",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    // DRAFT for Avi
    /** The map could not be drawn: the browser cannot, or the map could not be loaded. */
    failed: "We couldn't show the map.",
    // DRAFT for Avi
    /** The person searched an area of the map that has no places. */
    noneInArea: "No places listed in this area yet.",
    // DRAFT for Avi
    /**
     * After "Near" in the "Near …" control, for an area searched on the desktop's map that has no listed
     * town within a town's reach of its middle: "Near this map area"; and in the sentences that name
     * where the places are near: "No places near this map area match those filters."
     */
    thisMapArea: "this map area",
    // DRAFT for Avi
    /** The card of the pin chosen on the phone's map, for a screen reader: the region a pin opens. */
    selected: "Selected on the map",
    // DRAFT for Avi
    /**
     * Under the card of a pin that is one of a chain's places (each is a pin of its own; decision 25):
     * the way to the chain's page. "Part of Copper Kettle Coffee · 74 locations".
     */
    partOfChain: (name: string, n: number) => `Part of ${name}${dot}${locations(n)}`,
    /**
     * Over a map that the page scrolls past (a place's map), for a moment, when a scroll or one finger
     * moved the page and not the map: how to move the map instead. Ctrl on Windows and Linux, ⌘ on a
     * Mac, two fingers on a phone.
     */
    gestureHelp: {
      // DRAFT for Avi
      ctrl: "Use Ctrl + scroll to zoom the map",
      // DRAFT for Avi
      mac: "Use ⌘ + scroll to zoom the map",
      // DRAFT for Avi
      touch: "Use two fingers to move the map",
    },
  },
  /** The desktop's Explore (DeskExplore.dc.html): the list beside the map. */
  deskExplore: {
    /** Before the line that says whose scores they are: "9 places." */
    count: (n: number) => `${places(n)}.`,
    // DRAFT for Avi
    /**
     * In place of that, when an area searched on the map has more places than the list holds (the 50
     * nearest its middle; decision 25): "2,345 places in this area. Zoom in to see the rest." It says
     * the area that was searched, which a pan since does not change. With Open now on it counts the
     * places, open or not: counting the open ones would need every place's hours.
     */
    inArea: (n: number) => `${places(n)} in this area. Zoom in to see the rest.`,
    // DRAFT for Avi
    /**
     * In place of that, with Open now, when the list stopped reading places' hours (it reads so many and
     * no more) before it found as many open places as it holds: there may be more farther out.
     */
    nearestOpen: "Showing the open places nearest the middle of this area. Zoom in to see more.",
    // DRAFT for Avi
    /** In place of the list, when that found none. */
    noneOpenNearMiddle: "No open places near the middle of this area. Zoom in to see more.",
    /** The kinds menu, by what is chosen: none, one ("Cafes"), or several ("Kind of place · 2"). */
    kinds: (n: number, only: string) => (n === 0 ? kindOfPlace : n === 1 ? only : `${kindOfPlace} · ${n.toLocaleString("en")}`),
    /** The sort menu, by the order the list is in: nearest first, A to Z, or, for words, best match first. */
    sort: {
      // DRAFT for Avi
      score: "Sort: House picks' rating",
      // DRAFT for Avi
      /** The same, while My circle is the view. */
      circleScore: "Sort: My circle's rating",
      distance: "Sort: distance",
      name: "Sort: name",
      // DRAFT for Avi
      relevance: "Sort: best match",
    },
  },
  location: {
    // DRAFT for Avi: every string in this group but `pickTitle` (Avi, 2026-10-09) is a first draft and needs your edit.
    /** The word after "Near" in the header when the places are around the device: "Near you". */
    you: "you",
    /** The town picker's title. */
    pickTitle: "Choose a town",
    useMine: "Use my location",
    filterPlaceholder: "Search towns and cities",
    close: "Close",
    /** Shown under the filter when no town has the words typed. */
    noMatch: "No towns match that.",
    /** The number of places a town has: "7 places", "1 place", "7,954 places". */
    count: (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "place" : "places"}`,
    /**
     * The person said no to the device's location. `near` is where the places are, still: the
     * town guessed from the device's time zone, the default city, or the one they picked, or
     * `lastKnown` when they had been found before.
     */
    denied: (near: string) =>
      `Location is off, so we're showing places near ${near}. Pick a city, or turn on location in your browser settings.`,
    lastKnown: "where you last were",
    /** The position could not be found, whatever the reason but a no. */
    unavailable: "We couldn't find your location. Pick a city instead.",
    // DRAFT for Avi
    /** In place of "Near …" while the device has not said where it is yet. */
    finding: "Finding your location…",
  },
  /** The words after a distance: "0.6 mi", "1.1 km", "250 m". */
  units: {
    mi: "mi",
    km: "km",
    m: "m",
  },
} satisfies { readonly [key: string]: CopyNode };
