import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { NearButton } from "../location/CityPicker.tsx";
import { LocationNotice } from "../location/LocationNotice.tsx";
import { ThemeToggle } from "../theme/ThemeToggle.tsx";
import { AccountLink } from "./TopBar.tsx";

/**
 * The top of the phone's Explore (Main.dc.html): the wordmark, the dark mode switch and the account
 * button, then where the places are near, with the region that says when the person's location
 * could not be used.
 * The page goes on below it with the search field, the toggle and the chips.
 */
export function PhoneTop(): JSX.Element {
  return (
    <header className="flex flex-col gap-4 px-gutter-phone pt-[22px]">
      <div className="flex items-center justify-between">
        <p className="m-0 font-display text-[28px] font-extrabold tracking-display">{copy.app.name}</p>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <AccountLink size="phone" />
        </div>
      </div>
      <div className="flex flex-col">
        <NearButton />
        <LocationNotice />
      </div>
    </header>
  );
}
