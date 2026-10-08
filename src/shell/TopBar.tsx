import { type FormEvent, type JSX, type ReactNode, useId, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { initialOf, useOwnName } from "../account/useOwnName.ts";
import { copy } from "../copy/en.ts";
import { NearButton } from "../location/CityPicker.tsx";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { ThemeToggle } from "../theme/ThemeToggle.tsx";
import { PersonIcon, SearchIcon } from "../ui/icons.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { ViewSwitch } from "../ui/ViewToggle.tsx";

type AccountSize = "phone" | "desktop";

/**
 * The round button itself, which goes to the You page, named `label`. `phone` is 44 px (Main.dc.html);
 * `desktop` is drawn at 40 px (DeskExplore.dc.html) inside a 44 px target.
 */
function AccountButton({ size, label, children }: { size: AccountSize; label: string; children: ReactNode }): JSX.Element {
  return (
    <NavLink to="/you" end aria-label={label} className="flex size-11 shrink-0 items-center justify-center rounded-full">
      <span
        className={`flex items-center justify-center rounded-full bg-emphasis font-bold text-on-emphasis ${
          size === "phone" ? "size-11 text-body" : "size-10 text-[15px]"
        }`}
      >
        {children}
      </span>
    </NavLink>
  );
}

/**
 * The account button of the person signed in as `pubkey`: the first letter of their name, as the
 * design draws it (DeskExplore.dc.html, Tuning.dc.html), named "Sofia, your account" for a screen
 * reader. Until the name is known, or when their profile has none, the person icon, named "Your account".
 */
function PersonButton({ size, pubkey }: { size: AccountSize; pubkey: string }): JSX.Element {
  const name = useOwnName(pubkey);
  return (
    <AccountButton size={size} label={name === undefined ? copy.nav.yourAccount : copy.nav.accountOf(name)}>
      {name === undefined ? <PersonIcon size={20} /> : <span lang={scriptLang(name)}>{initialOf(name)}</span>}
    </AccountButton>
  );
}

/**
 * The round account button. Before sign in, the person icon: it goes to the You page, which asks
 * the person to sign in. After, it is theirs (`PersonButton`).
 */
export function AccountLink({ size }: { size: AccountSize }): JSX.Element {
  const { account } = useAccount();
  return account === undefined ? (
    <AccountButton size={size} label={copy.nav.account}>
      <PersonIcon size={20} />
    </AccountButton>
  ) : (
    <PersonButton size={size} pubkey={account.pubkey} />
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
 * The desktop's one top bar (DeskExplore.dc.html): the wordmark, the search field with the
 * location inside it, the House picks / My circle toggle, the dark mode switch, Saved and the
 * account button. Under it, the region that says when the person's location could not be used.
 */
export function TopBar(): JSX.Element {
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
          <NavLink
            to="/saved"
            className={({ isActive }) =>
              `inline-flex min-h-touch items-center text-[15px] no-underline ${
                isActive ? "font-bold text-accent" : "font-semibold text-ink hover:text-accent"
              }`
            }
          >
            {copy.nav.saved}
          </NavLink>
          <AccountLink size="desktop" />
        </div>
      </header>
      <LocationNotice className="px-gutter-desktop *:pt-2.5" />
    </>
  );
}
