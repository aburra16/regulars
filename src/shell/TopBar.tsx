import { type FormEvent, type JSX, useId, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { NearButton } from "../location/CityPicker.tsx";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { PersonIcon, SearchIcon } from "../ui/icons.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";

/**
 * The round account button. Before sign in, it goes to the You page, which asks the person to
 * sign in. `phone` is 44 px (Main.dc.html); `desktop` is drawn at 40 px (DeskExplore.dc.html)
 * inside a 44 px target.
 */
export function AccountLink({ size }: { size: "phone" | "desktop" }): JSX.Element {
  return (
    <Link to="/you" aria-label={copy.nav.account} className="flex size-11 shrink-0 items-center justify-center rounded-full">
      <span
        className={`flex items-center justify-center rounded-full bg-ink text-ground ${size === "phone" ? "size-11" : "size-10"}`}
      >
        <PersonIcon size={20} />
      </span>
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
 * The desktop's one top bar (DeskExplore.dc.html): the wordmark, the search field with the
 * location inside it, the House picks / My circle toggle, Saved and the account button. Under it,
 * the region that says when the person's location could not be used.
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
