import { type FormEvent, type JSX, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { initialOf, useOwnProfile } from "../account/useOwnName.ts";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { NearButton } from "../location/CityPicker.tsx";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { BUSY_CONTROL, type InlineSignIn, InlineSignInLines, useInlineSignIn } from "../signin/InlineSignIn.tsx";
import { landingFrom } from "../signin/returnTo.ts";
import { ThemeToggle } from "../theme/ThemeToggle.tsx";
import { PersonIcon, SearchIcon, TrendingIcon } from "../ui/icons.tsx";
import { ProfilePicture } from "../ui/ProfilePicture.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { ViewSwitch } from "../ui/ViewToggle.tsx";

type AccountSize = "phone" | "desktop";

/** The round target of the account button: 44 px. */
const ROUND = "flex size-11 shrink-0 items-center justify-center rounded-full";

/** The disc inside it: 44 px on a phone (Main.dc.html); drawn at 40 px on a desktop (DeskExplore.dc.html). */
function Disc({ size, children }: { size: AccountSize; children: ReactNode }): JSX.Element {
  return (
    <span
      className={`flex items-center justify-center rounded-full bg-emphasis font-bold text-on-emphasis ${
        size === "phone" ? "size-11 text-body" : "size-10 text-[15px]"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * The account button's signing in where the person is (decision 23), for the top that draws it: the
 * button, and the lines under the top (`AccountSignInLines`). Signed in here, the button that is now
 * the person's takes the focus (`focusNext`), as the one they pressed is gone; on a page that only
 * asked them to sign in (You, Saved), they go on to Explore, as its own Sign in takes them. The top
 * stays from page to page: on another page, what it said of signing in on the last one is over.
 */
export interface AccountSignIn {
  inline: InlineSignIn;
  focusNext: RefObject<boolean>;
}

export function useAccountSignIn(): AccountSignIn {
  const location = useLocation();
  const navigate = useNavigate();
  const focusNext = useRef(false);
  const inline = useInlineSignIn({ from: location }, () => {
    focusNext.current = true;
    if (landingFrom({ from: location }) === undefined) void navigate("/");
  });
  const { reset } = inline;
  const at = useRef(location.key);
  useEffect(() => {
    if (at.current === location.key) return;
    at.current = location.key;
    reset();
  }, [location.key, reset]);
  return { inline, focusNext };
}

/** The lines under the top while the account button signs the person in: at its end, under the button. */
export function AccountSignInLines({ signIn, className = "" }: { signIn: AccountSignIn; className?: string }): JSX.Element {
  const { account } = useAccount();
  return <>{account === undefined && <InlineSignInLines inline={signIn.inline} align="end" className={className} />}</>;
}

/**
 * The account button of the person signed in as `pubkey`, which goes to the You page: the picture
 * in their profile, filling the circle (`ProfilePicture`), else the first letter of their name, as
 * the design draws it (DeskExplore.dc.html, Tuning.dc.html), named "Sofia, your account" for a screen
 * reader. Until the name is known, or when their profile has none, the person icon, named "Your
 * account". A picture that will not load gives way to the initial. `focusNext`: it has just become
 * theirs by a press of it, and takes the focus.
 *
 * Privacy: the picture's address comes only from the person's own signed profile, and the image host
 * it names sees their IP address, their browser, and when they open Regulars; with no referrer, not
 * which page. Reviewers' pictures are loaded the same way beside their reviews (Avi, 2026-10-09), so
 * the hosts they name see each visitor of a place's page.
 */
function PersonButton({ size, pubkey, focusNext }: { size: AccountSize; pubkey: string; focusNext: RefObject<boolean> }): JSX.Element {
  const { name, picture } = useOwnProfile(pubkey);
  const button = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    button.current?.focus({ preventScroll: true });
  }, [focusNext]);
  return (
    <NavLink ref={button} to="/you" end aria-label={name === undefined ? copy.nav.yourAccount : copy.nav.accountOf(name)} className={ROUND}>
      <Disc size={size}>
        <ProfilePicture
          address={picture}
          fallback={name === undefined ? <PersonIcon size={20} /> : <span lang={scriptLang(name)}>{initialOf(name)}</span>}
        />
      </Disc>
    </NavLink>
  );
}

/**
 * The round account button. Before sign in, the person icon, which signs the person in (decision 23):
 * where the browser has an add-on, at once, here, and they stay on the page; else it goes to the
 * sign-in page, which brings them back here. While the add-on asks it is busy. After, it is theirs
 * (`PersonButton`).
 */
export function AccountLink({ size, signIn }: { size: AccountSize; signIn: AccountSignIn }): JSX.Element {
  const { account } = useAccount();
  const { inline } = signIn;
  if (account !== undefined) return <PersonButton size={size} pubkey={account.pubkey} focusNext={signIn.focusNext} />;
  const asking = inline.phase === "asking";
  return (
    <Link
      ref={inline.control}
      to="/signin"
      state={inline.state}
      onClick={inline.onClick}
      aria-label={copy.nav.signIn}
      aria-busy={asking ? true : undefined}
      aria-disabled={asking ? true : undefined}
      className={`${ROUND} ${BUSY_CONTROL}`}
    >
      <Disc size={size}>
        <PersonIcon size={20} />
      </Disc>
    </Link>
  );
}

/**
 * The search field, with where the places are near at its end. Enter searches; on the search page
 * a new search keeps the filters that are on.
 */
function SearchField(): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const inputId = useId();

  // The field shows the search that is on screen, and empties when the person leaves it.
  const onSearch = pathname === "/search";
  const shownSearch = onSearch ? (params.get("q") ?? "") : "";
  const [text, setText] = useState(shownSearch);
  const [lastShown, setLastShown] = useState(shownSearch);
  if (shownSearch !== lastShown) {
    setLastShown(shownSearch);
    setText(shownSearch);
  }

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = text.trim();
    if (query === "") return;
    const next = new URLSearchParams(onSearch ? params : undefined);
    next.set("q", query);
    void navigate({ pathname: "/search", search: `?${next.toString()}` });
  };

  return (
    <form
      role="search"
      onSubmit={search}
      className="flex h-12 max-w-[540px] min-w-0 flex-[1_1_340px] items-center gap-2.5 rounded-tile bg-surface pr-1.5 pl-4 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ink"
    >
      <SearchIcon size={20} className="shrink-0 text-muted" />
      <label htmlFor={inputId} className="sr-only">
        {copy.search.label}
      </label>
      <input
        id={inputId}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={copy.search.placeholder}
        autoComplete="off"
        enterKeyHint="search"
        className="h-11 min-w-0 flex-1 border-0 bg-transparent p-0 font-text text-body text-ink outline-none placeholder:text-muted"
      />
      <NearButton variant="pill" />
    </form>
  );
}

/**
 * A page's link in the top bar, in words, 44 px tall, with its icon before them when it has one: in the
 * accent, and bold, while its page is open.
 */
const pageLink = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-touch items-center gap-1.5 text-[15px] no-underline ${
    isActive ? "font-bold text-accent" : "font-semibold text-ink hover:text-accent"
  }`;

/**
 * The desktop's one top bar (DeskExplore.dc.html): the wordmark, the search field with the
 * location inside it, the House picks / My circle toggle (whose My circle half opens Personalize in a
 * panel under it, before the person's circle is asked for), the dark mode switch, the links to pages
 * (Trending, the newest reviews, with its rising arrow before the word; Saved once saved lists open,
 * `config.features.saved`), and the account
 * button. The links sit with the account button, past the switch, as the way to other pages, apart
 * from the toggle that changes the scores, in a navigation of their own (`copy.nav.pages`). Under it, the lines of the account button signing the
 * person in, and the region that says when the person's location could not be used.
 */
export function TopBar(): JSX.Element {
  const signIn = useAccountSignIn();
  return (
    <>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3.5 border-b-token border-line px-gutter-desktop py-3.5">
        <Link to="/" className="font-display text-[26px] font-extrabold tracking-display text-ink no-underline">
          {copy.app.name}
        </Link>
        <SearchField />
        <div className="ml-auto flex flex-wrap items-center gap-x-[18px] gap-y-3">
          <ViewSwitch variant="compact" />
          <ThemeToggle />
          {/* Named apart from the phone's tabs ("Main"), which a desktop never has. */}
          <nav aria-label={copy.nav.pages} className="flex items-center gap-x-[18px]">
            <NavLink to="/trending" className={pageLink}>
              <TrendingIcon size={18} />
              {copy.nav.recent}
            </NavLink>
            {config.features.saved && (
              <NavLink to="/saved" className={pageLink}>
                {copy.nav.saved}
              </NavLink>
            )}
          </nav>
          <AccountLink size="desktop" signIn={signIn} />
        </div>
      </header>
      <AccountSignInLines signIn={signIn} className="px-gutter-desktop pt-2.5" />
      <LocationNotice className="px-gutter-desktop *:pt-2.5" />
    </>
  );
}
