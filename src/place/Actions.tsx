import type { JSX, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import { NewTabHint, Unseen } from "../ui/NewTab.tsx";
import { goUrl } from "./osmLinks.ts";

/** What a place lets the person do from its page: directions always, a call and its website when it has them. */
export interface PlaceActions {
  go: string;
  /** A `tel:` link, when the place has a number that can be called. */
  call?: string;
  /** The website, when it is a web address, and its host to name it by. */
  site?: { href: string; host: string };
}

/** The longest host a link is named by, in characters; past it, it ends in an ellipsis. */
const HOST_MAX = 40;

/**
 * What a number to call looks like once its spaces are out: digits and the dots, dashes and
 * brackets people write between them, with a + at the start or just inside an opening bracket
 * ("(+258) 87 022 7777").
 */
const DIALLABLE = /^\(?\+?[0-9().-]+$/;

/** Bidirectional marks and other invisible format characters, which a number copied from a page can carry. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/** How many digits a number before a "/" must have to be a whole number, not an area code ("0761 / 12345"). */
const WHOLE_NUMBER_DIGITS = 6;

const digitsIn = (text: string) => text.replace(/\D/g, "").length;

/**
 * The number to call, as a `tel:` link: the first of the numbers given (OpenStreetMap separates
 * them with ";", and people with "," or "/"), read as a dialler would. Full-width digits and plus
 * signs become plain ones, invisible marks go, an extension ("x203", "ext. 12") is left off, and
 * what is dialled is the + and the digits alone: "tel:+258870227777". Nothing for text that is not a
 * number: it comes from a relay, and only a number makes a link. The page shows the number as written.
 */
function callLink(phone: string | undefined): string | undefined {
  if (phone === undefined) return undefined;
  const text = phone.normalize("NFKC").replace(FORMAT_CHARACTERS, "");
  const first = text.split(/[;,]/)[0] ?? "";
  // A slash between two whole numbers separates them; after an area code it is part of the one.
  const [head = "", ...tail] = first.split("/");
  const one = tail.length > 0 && digitsIn(head) >= WHOLE_NUMBER_DIGITS ? head : first.replace(/\//g, "");
  const number = (one.split(/ext|x/i)[0] ?? "").replace(/\s+/g, "");
  if (!DIALLABLE.test(number) || digitsIn(number) < 3) return undefined;
  return `tel:${number.includes("+") ? "+" : ""}${number.replace(/\D/g, "")}`;
}

/**
 * A website without its scheme, as many are written: a host name with a dot ("jhcoffee.co.za",
 * "www.catchtwentyseven.com"), perhaps with a path. Not an address with "@" (an email, or a social
 * handle such as "@lamenaga"), nor anything with a space or a ":" (another scheme, such as "mailto:").
 */
const BARE_HOST = /^[\p{L}\p{N}][^\s@:]*\.[^\s@:]+$/u;

/** The website, when it is an address on the web (http or https, or a bare host name read as https), with its host cut short. Nothing for anything else. */
function siteLink(website: string | undefined): PlaceActions["site"] {
  if (website === undefined) return undefined;
  let href: string;
  if (/^https?:\/\//i.test(website)) href = website;
  else if (BARE_HOST.test(website)) href = `https://${website}`;
  else return undefined;
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return undefined;
  }
  // A bare host name must still name a host on the web once read: one with a dot in it.
  if (host === "" || (href !== website && !host.includes("."))) return undefined;
  const characters = [...host];
  return {
    href,
    host: characters.length > HOST_MAX ? `${characters.slice(0, HOST_MAX).join("")}…` : host,
  };
}

/** The actions a place has. */
export function actionsOf(place: Pick<Place, "lat" | "lon" | "phone" | "website">): PlaceActions {
  return { go: goUrl(place), call: callLink(place.phone), site: siteLink(place.website) };
}

/** The design's directions arrow, call handset and globe (Place.dc.html), 18 px, in the text colour. */
function ActionIcon({ kind }: { kind: "go" | "call" | "site" }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {kind === "go" && <path d="M3 11l18-8-8 18-2-8z" />}
      {kind === "call" && <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />}
      {kind === "site" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
        </>
      )}
    </svg>
  );
}


interface Action {
  kind: "go" | "call" | "site";
  href: string;
  words: string;
  /** Said to a screen reader after the words: where the link goes. */
  more?: string;
  /** The link leaves the app, for a page that is not ours: a new tab, telling it nothing of where it came from. */
  out?: "noopener noreferrer" | "noopener noreferrer nofollow ugc";
}

function actionList(actions: PlaceActions, alone: boolean): Action[] {
  const list: Action[] = [];
  if (actions.go !== "") {
    list.push({ kind: "go", href: actions.go, words: alone ? copy.place.directions : copy.place.go, out: "noopener noreferrer" });
  }
  if (actions.call !== undefined) list.push({ kind: "call", href: actions.call, words: copy.place.call });
  if (actions.site !== undefined) {
    // The website is the place's own, as the relay gave it: no endorsement from us, and nothing about where the person came from.
    list.push({ kind: "site", href: actions.site.href, words: copy.place.site, more: actions.site.host, out: "noopener noreferrer nofollow ugc" });
  }
  return list;
}

function ActionLink({ action, className, icon }: { action: Action; className: string; icon: boolean }): JSX.Element {
  const words: ReactNode[] = [action.words];
  if (action.more !== undefined) words.push(<Unseen key="more" text={action.more} />);
  // The link leaves the app.
  if (action.out !== undefined) words.push(<NewTabHint key="out" />);
  return (
    <a
      href={action.href}
      target={action.out === undefined ? undefined : "_blank"}
      rel={action.out}
      title={action.more}
      className={className}
    >
      {icon && <ActionIcon kind={action.kind} />}
      {words}
    </a>
  );
}

/** A button of the phone's (Place.dc.html): 52 px, a 1.5 px ink edge, the icon and the word. */
const phoneButton =
  "flex h-13 min-w-0 items-center justify-center gap-2 rounded-button border-token border-ink px-2 text-[15px] font-bold text-ink no-underline";

/**
 * The phone's actions, only those the place has. Two or three sit side by side, each an icon and a
 * word (Place.dc.html); directions on their own fill the width and say so (PlaceNew.dc.html).
 */
export function PhoneActions({ actions }: { actions: PlaceActions }): JSX.Element | null {
  const alone = actions.call === undefined && actions.site === undefined;
  const list = actionList(actions, alone);
  if (list.length === 0) return null;
  if (alone) return <ActionLink action={list[0]!} icon className={`${phoneButton} w-full`} />;
  return (
    <div className={`grid gap-2.5 ${list.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
      {list.map((action) => (
        <ActionLink key={action.kind} action={action} icon className={phoneButton} />
      ))}
    </div>
  );
}

/** A button of the desktop's rail (DeskPlace.dc.html): 48 px, a 1.5 px ink edge, the word alone. */
const railButton =
  "flex h-12 min-w-0 items-center justify-center gap-1.5 rounded-tile border-token border-ink px-2 text-secondary font-bold text-ink no-underline";

/**
 * The desktop's actions, in the rail (DeskPlace.dc.html): Go, Call and Site, those the place has,
 * and Save, which asks the person to sign in first. As many to a row as fit.
 */
export function RailActions({ actions }: { actions: PlaceActions }): JSX.Element {
  const location = useLocation();
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(86px,100%),1fr))] gap-2">
      {actionList(actions, false).map((action) => (
        <ActionLink key={action.kind} action={action} icon={false} className={railButton} />
      ))}
      <Link to="/signin" state={{ from: location }} className={railButton}>
        {copy.place.saveShort}
      </Link>
    </div>
  );
}
