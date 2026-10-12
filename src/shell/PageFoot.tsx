import { createContext, type JSX } from "react";

import { BuiltOnBrainstorm } from "../ui/BuiltOnBrainstorm.tsx";

/**
 * Whether the shell draws its foot under the page that is open. It does for every page that scrolls,
 * and not for one that fills the window, which sees to the line itself or has none (the desktop's
 * list beside the map; the phone's map). What stands in such a page's place reads this, and draws the
 * foot where the shell does not: the page that says something went wrong (./PageError.tsx), which the
 * shell cannot see has taken the page's place. Outside the shell, true: whatever draws a page there
 * draws its foot too.
 */
export const ShellFoot = createContext(true);

/** The line's column in the shell's foot: centred on a phone; on a desktop, at the start of the column the pages' content is in. */
const FOOT_COLUMN = "flex justify-center px-gutter-phone wide:mx-auto wide:w-full wide:max-w-content wide:justify-start wide:px-gutter-desktop";

/**
 * The shell's own foot, the last thing on a page: "Built on Brainstorm", in a
 * footer outside the page, after the page's content and any footer of its own. It is in the page's
 * flow, so on a phone it is above the tabs, never under them, and a page shorter than the screen has
 * it at the foot of the screen.
 *
 * Under the line, on a phone: a little room, and more on a page with no tabs (`tabs`), where the line
 * would else be at the very foot of the screen, by the phone's home indicator. It is the same whatever
 * is over the page: the bar about the person's circle is given no room, so nothing on a page moves as
 * that bar comes and goes, and at a page's end the line is under it for the ten seconds it shows
 * (ruling R54). On a desktop the line is at the start and the bar in the middle.
 *
 * `night` draws it on the sign-in page's dark ground, in the light theme's colours, as that page is.
 */
export function PageFoot({ night = false, tabs = false }: { night?: boolean; tabs?: boolean }): JSX.Element {
  const below = `${tabs ? "pb-1.5" : "pb-2"} wide:pb-3`;
  if (night) {
    return (
      <footer data-theme="light" className={`on-dark bg-night ${below}`}>
        <div className={FOOT_COLUMN}>
          <BuiltOnBrainstorm tone="night" />
        </div>
      </footer>
    );
  }
  return (
    <footer className={below}>
      <div className={FOOT_COLUMN}>
        <BuiltOnBrainstorm />
      </div>
    </footer>
  );
}
