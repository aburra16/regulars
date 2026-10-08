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

/** The heading of the kinds filter, and the name of the desktop's kinds menu while none is chosen. */
const kindOfPlace = "Kind of place";

/** A page's title in the browser's tab: "Search · Regulars". */
const pageTitle = (page: string) => `${page} · ${config.appName}`;

/** What joins the parts of a line: "Cafe · 0.3 mi", "Closed · opens 7 am". */
const dot = " · ";

/** A chain's kind and size (Main.dc.html): "Coffee shop · 74 locations". */
const chainKind = (kind: string, n: number) => `${kind}${dot}${locations(n)}`;

/** How many of a chain's places are near, in the line under its name: "3 near you". */
const nearYou = (n: number) => `${n === 0 ? "none" : n.toLocaleString("en")} near you`;

/** What joins the two parts of the hours inside a line that dots join already (DeskPlace.dc.html): "Open now, closes 10 pm". */
const comma = ", ";

/** A link back to the first page. */
const backToExplore = "Back to Explore";

/** "phone", "phone or website", "phone, website or hours". */
const eitherOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

export const copy = {
  app: {
    name: config.appName,
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
      score: "Best in My circle first",
      distance: "Nearest first",
      name: "A to Z",
      // DRAFT for Avi: words that are not a kind of place are listed best match first.
      relevance: "Best match first",
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
    // DRAFT for Avi
    missing: pageTitle("Not found"),
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
      "Right now you're seeing House picks. Sign in and every score is worked out from the people you trust, and the people they trust.",
    /** The three steps. SignIn.dc.html's first step says "follow", which nothing in the app may; DeskSignIn.dc.html says "trust". */
    steps: [
      "Sign in. We read who you already trust.",
      "We work out your circle. It takes a few minutes, in the background.",
      "Switch between House picks and My circle whenever you like.",
    ],
    /** The second button: go back to where the person was, with the house's scores. */
    keepHousePicks: "Keep House picks",
    /** The notice about what personalizing does (the brief, section 6). */
    notice: "Nothing is posted without you. Your circle's scores are worked out by our scoring partner and are public.",
    howItWorks: "First time? How signing in works",
    // DRAFT for Avi
    /** The numbered list of steps, for a screen reader. */
    stepsLabel: "The three steps",
  },
  /** The pages that need a person, before sign in opens (Saved and You). The design draws neither signed out. */
  saved: {
    // DRAFT for Avi
    signedOut: "Sign in to save places and make lists you can share.",
  },
  you: {
    // DRAFT for Avi
    signedOut: "Sign in to see your reviews and the people you trust.",
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
    licenceLink: "Licence and copyright",
    // DRAFT for Avi
    /** The link to the licences of the software the site is built from (a text file the build writes). */
    softwareLicences: "Software licences",
    reviewsHeading: "Where the reviews come from",
    reviewsBody:
      "People write them under their own names. Nobody at Regulars edits or reorders them. The score you see for a place is worked out from the reviewers you trust, so two people can see different scores for the same place.",
    // DRAFT for Avi: the two views in plain words, where House picks are said once. The design links to a "How scores are worked out" page, which is for people who have signed in.
    viewsBody:
      "House picks are the scores from the reviewers that the house trusts, and everyone starts there. My circle is the same, worked out from the people you trust and the people they trust. You can switch between them whenever you like.",
    houseHeading: "Who the house is",
    // DRAFT for Avi: the design's sentence says what House picks are, which the section above now does.
    houseBody:
      "Mise en Place, our house curator, is the house. It trusts the reviewers behind House picks, and it also keeps the list of places up to date.",
    signingInHeading: "How signing in works",
    signingInBody:
      "You sign in with an account you hold yourself, through a sign-in app in your browser or on your phone. Regulars never sees a password, and nothing is posted unless you press Post.",
    yoursHeading: "Your reviews are yours",
    yoursBody:
      "Places, reviews and lists are public records that don't live inside this app. Other apps can read the same ones, and yours stay with you if you leave.",
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
    /** The buttons under it: directions, a call, the website. One on its own is "Get directions". */
    go: "Go",
    directions: "Get directions",
    call: "Call",
    site: "Site",
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
    /** The map of the place, which does not move, as one picture for a screen reader. */
    mapLabel: (name: string) => `Map showing where ${name} is`,
    // DRAFT for Avi
    /** The desktop's side rail (DeskPlace.dc.html), for a screen reader. */
    railLabel: "Details and directions",
    /** The places closest to this one. Before sign in nothing is rated, so not "Nearby, rated by your circle". */
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
    near: (label: string) => `Near ${label}`,
    /** Under the toggle, while it is on House picks (Main.dc.html). "How this works" follows it, as a link. */
    houseLine: "Scores from the reviewers that Mise en Place, our house curator, trusts.",
    howThisWorks: "How this works",
    /** The filter chips, for a screen reader. */
    filtersLabel: "Filter places",
    /** The chips. Restaurants and Cafes are the kind families' own names. */
    chips: { all: "All", open: "Open now", more: "More" },
    /** What a place is and how far it is: "Mexican restaurant · 1.1 mi". */
    kindLine: (kind: string, distance: string) => (distance === "" ? kind : `${kind}${dot}${distance}`),
    chainKind,
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
  /** A chain's page (Chain.dc.html): the places that share a name, and which of them are near. */
  chain: {
    /** Under the chain's name (Chain.dc.html): what it is, how many places have its name and how many are near: "Coffee shop · 74 locations · 3 near you". */
    line: (kind: string, n: number, near: number) => `${chainKind(kind, n)}${dot}${nearYou(near)}`,
    // DRAFT for Avi: "none near you" is not drawn; the design has a chain with three near.
    nearYou,
    eachScored: "Each location is scored on its own",
    // DRAFT for Avi: the design's second sentence goes on "Near you, your circle rates them from 3.6 to 4.4", which needs scores.
    eachScoredDetail: "A good one here says little about the one across town.",
    /** The heading over the locations that are near. */
    near: "Near you",
    // DRAFT for Avi: the heading over the nearest three, when none is near.
    nearest: "Nearest locations",
    /** The link beside "Near you", on a phone, to the map. */
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
     * A place's pin, for a screen reader: its name, what it is and its hours, then that nobody has
     * reviewed it, which the ring says to the eye. "Dose, Cafe, Open until 6 pm, no reviews yet".
     */
    placePin: (name: string, kind: string, hours: string) => `${name}, ${kind}, ${hours}, no reviews yet`,
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
    /** Where a search of the map is, in a sentence that names where the places are: "No places near this area match those filters." */
    thisArea: "this area",
    // DRAFT for Avi
    /** The card of the pin chosen on the phone's map, for a screen reader: the region a pin opens. */
    selected: "Selected on the map",
  },
  /** The desktop's Explore (DeskExplore.dc.html): the list beside the map. */
  deskExplore: {
    /** Before the line that says whose scores they are: "9 places." */
    count: (n: number) => `${places(n)}.`,
    /** The kinds menu, by what is chosen: none, one ("Cafes"), or several ("Kind of place · 2"). */
    kinds: (n: number, only: string) => (n === 0 ? kindOfPlace : n === 1 ? only : `${kindOfPlace} · ${n.toLocaleString("en")}`),
    /** The sort menu, by the order the list is in: nearest first, A to Z, or, for words, best match first. */
    sort: {
      distance: "Sort: distance",
      name: "Sort: name",
      // DRAFT for Avi
      relevance: "Sort: best match",
    },
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
