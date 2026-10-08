import { config } from "../config.ts";

/**
 * Every string a person can read lives in this file. tests/copy.test.ts fails on
 * protocol vocabulary anywhere in it (nostr, relay, key, sign ...), and in the kind
 * labels in src/data/kinds.json. These two strings are the only exceptions, and only as
 * the entire text of copy.signin.continueButton and copy.place.bitcoinChip.
 * "Sign in" is the app's word for authenticating; "signed in" and "signed out" are
 * not allowed, so write "after you sign in".
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
};

/** How many places a chain has: "74 locations". */
const locations = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "location" : "locations"}`;

/** How many places: "7 places", "1 place". */
const places = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "place" : "places"}`;

/** A page's title in the browser's tab: "Search · Regulars". */
const pageTitle = (page: string) => `${page} · ${config.appName}`;

export const copy = {
  app: {
    name: config.appName,
  },
  meta: {
    description: "Restaurant ratings from people you'd actually ask.",
  },
  /** The tabs on a phone, and the links in the desktop top bar. */
  nav: {
    /** The name of the tab bar, for a screen reader. */
    label: "Main",
    explore: "Explore",
    map: "Map",
    saved: "Saved",
    you: "You",
    /** The round account button, for a screen reader. */
    account: "Your account and your circle",
  },
  search: {
    /** The search field's name, for a screen reader. */
    label: "Search places",
    placeholder: "Tacos, coffee, a place name",
    /** The arrow at the top left of the results, for a screen reader. */
    back: "Back to Explore",
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
      score: "Best in My circle first",
      distance: "Nearest first",
      name: "A to Z",
    },
    /** A chain in the results, in place of a score (Search.dc.html): "3 near you, 2 open now". */
    chainNearbyOpen: (near: number, open: number) =>
      `${near.toLocaleString("en")} near you, ${open === 0 ? "none" : open.toLocaleString("en")} open now`,
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
  },
  filters: {
    /** The cross at the top right, for a screen reader. */
    close: "Close filters",
    sortBy: "Sort by",
    /** The ways to sort. */
    sort: { score: "My circle's score", distance: "Distance", name: "Name" },
    // DRAFT for Avi
    /** Why the first of them cannot be chosen yet. */
    sortScoreSignedOut: "Sign in to sort by your circle's scores",
    openNow: "Open now",
    openNowNote: "Keeps places with no hours listed.",
    distance: "Distance",
    kinds: "Kind of place",
    clearAll: "Clear all",
    /** The button that applies them (Filters.dc.html): "Show 5 places". */
    show: (n: number) => (n === 0 ? "No places match" : `Show ${places(n)}`),
  },
  /** The House picks / My circle toggle. */
  view: {
    // DRAFT for Avi
    /** The toggle's name, for a screen reader. */
    label: "Whose scores to show",
    house: "House picks",
    circle: "My circle",
    /** A half of the toggle with its score, on the place page: "House picks · 4.5". */
    withScore: (view: string, score: string) => `${view} · ${score}`,
  },
  score: {
    /** On a card with no score, under the hours, when nobody has reviewed the place (SCREENS.md, wording patterns). */
    noReviewsYet: "No reviews yet",
    /** At the top right of a dashed card, where the score would be: others have rated the place, the list's view has not (Main.dc.html). */
    noScoreYet: "No score yet",
    /** A score as it is shown: "4.5", "4.0". */
    value: (n: number) => n.toLocaleString("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    /** The stars, for a screen reader: "4.5 out of 5". */
    starsLabel: (n: number) => `${n.toLocaleString("en", { maximumFractionDigits: 1 })} out of 5`,
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
    home: "Back to Explore",
  },
  // DRAFT for Avi
  /** A page that broke while it was drawn. */
  broken: {
    text: "Something went wrong on this page.",
    home: "Back to Explore",
  },
  /** The title of each page in the browser's tab. Explore is the app's name; the rest put theirs before it. */
  titles: {
    explore: config.appName,
    map: pageTitle(pages.map),
    search: pageTitle(pages.search),
    filters: pageTitle(pages.filters),
    place: pageTitle(pages.place),
    chain: pageTitle(pages.chain),
    about: pageTitle(pages.about),
    signin: pageTitle(pages.signin),
    saved: pageTitle(pages.saved),
    you: pageTitle(pages.you),
    // DRAFT for Avi
    missing: pageTitle("Not found"),
  },
  signin: {
    continueButton: ALLOWED_PROTOCOL_STRINGS.signInButton,
  },
  place: {
    bitcoinChip: ALLOWED_PROTOCOL_STRINGS.bitcoinChip,
  },
  hours: {
    /** A time of day goes in `time`: "11 pm" or "23:00", and "Tue 11 am" when it is more than a day away. */
    openUntil: (time: string) => `Open until ${time}`,
    openNowCloses: (time: string) => `Open now · closes ${time}`,
    closedOpens: (time: string) => `Closed · opens ${time}`,
    open24: "Open 24 hours",
    closed: "Closed",
    notListed: "Hours not listed",
    /** The two halves of the day on a 12-hour clock. */
    am: "am",
    pm: "pm",
    /** Monday first. The weekday before a time that is more than a day away: "Closed · opens Mon 9 am". */
    weekdaysShort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
  explore: {
    // DRAFT for Avi
    /** The control at the top of the page. `label` is where the places are near: "Funchal", or "you". */
    near: (label: string) => `Near ${label}`,
    /** Under the toggle, while it is on House picks (Main.dc.html). "How this works" follows it, as a link. */
    houseLine: "Scores from the reviewers that Mise en Place, our house curator, trusts.",
    howThisWorks: "How this works",
    /** The filter chips, for a screen reader. */
    filtersLabel: "Filter places",
    /** The chips. Restaurants and Cafes are the kind families' own names. */
    chips: { all: "All", open: "Open now", more: "More" },
    /** What a place is and how far it is: "Mexican restaurant · 1.1 mi". */
    kindLine: (kind: string, distance: string) => (distance === "" ? kind : `${kind} · ${distance}`),
    /** A chain's kind and size (Main.dc.html): "Coffee shop · 74 locations". */
    chainKind: (kind: string, n: number) => `${kind} · ${locations(n)}`,
    /** How many of a chain are around: "3 near you, the closest 0.6 mi". */
    chainNearby: (n: number, distance: string) => `${n.toLocaleString("en")} near you, the closest ${distance}`,
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
  location: {
    // DRAFT for Avi: every string in this group is a first draft and needs your edit.
    /** The word after "Near" in the header when the places are around the device: "Near you". */
    you: "you",
    pickTitle: "Choose a place",
    useMine: "Use my location",
    filterPlaceholder: "Search towns and cities",
    close: "Close",
    /** Shown under the filter when no town has the words typed. */
    noMatch: "No towns match that.",
    /** The number of places a town has: "7 places", "1 place", "7,954 places". */
    count: (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "place" : "places"}`,
    /**
     * The person said no to the device's location. `near` is where the places are, still: the
     * default city, or the one they picked, or `lastKnown` when they had been found before.
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
