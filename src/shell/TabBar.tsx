import type { JSX } from "react";
import { NavLink } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { MapIcon, PersonIcon, RecentIcon, SavedIcon, SearchIcon } from "../ui/icons.tsx";

const TABS = [
  { to: "/", label: copy.nav.explore, Icon: SearchIcon },
  { to: "/map", label: copy.nav.map, Icon: MapIcon },
  { to: "/recent", label: copy.nav.recent, Icon: RecentIcon },
  { to: "/saved", label: copy.nav.saved, Icon: SavedIcon },
  { to: "/you", label: copy.nav.you, Icon: PersonIcon },
] as const;

/**
 * The phone's tabs, at the foot of the screen (Main.dc.html): Explore, Map, Recent, Saved and You, each
 * an equal share of the bar. Recent is the newest reviews (Avi, 2026-10-08). Saved is left out until
 * saved lists open (`config.features.saved`).
 */
export function TabBar(): JSX.Element {
  const tabs = TABS.filter(({ to }) => to !== "/saved" || config.features.saved);
  return (
    <nav
      aria-label={copy.nav.label}
      className="sticky bottom-0 z-10 flex min-h-(--tab-bar-height) border-t-token border-line bg-ground px-2 pt-1.5 pb-3.5"
    >
      {tabs.map(({ to, label, Icon }) => (
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
