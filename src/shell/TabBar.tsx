import type { JSX } from "react";
import { NavLink } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { MapIcon, PersonIcon, SavedIcon, SearchIcon } from "../ui/icons.tsx";

const TABS = [
  { to: "/", label: copy.nav.explore, Icon: SearchIcon },
  { to: "/map", label: copy.nav.map, Icon: MapIcon },
  { to: "/saved", label: copy.nav.saved, Icon: SavedIcon },
  { to: "/you", label: copy.nav.you, Icon: PersonIcon },
] as const;

/** The phone's tabs, at the foot of the screen (Main.dc.html): Explore, Map, Saved and You. */
export function TabBar(): JSX.Element {
  return (
    <nav
      aria-label={copy.nav.label}
      className="sticky bottom-0 z-10 flex h-(--tab-bar-height) border-t-token border-line bg-ground px-2 pt-1.5 pb-3.5"
    >
      {TABS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            `flex min-h-[52px] flex-1 flex-col items-center justify-center gap-[3px] text-tab no-underline ${
              isActive ? "font-bold text-accent" : "font-semibold text-muted"
            }`
          }
        >
          <Icon size={22} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
