import type { JSX } from "react";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { NewTabHint } from "./NewTab.tsx";

/**
 * Brainstorm's mark, the "B": one path on a box 71 wide and 73 tall, copied as Brainstorm draws it
 * (2,280 characters), never redrawn or made simpler. It is Brainstorm's mark, used here with
 * permission. tests/builtOnBrainstorm.test.tsx holds it to what was copied.
 */
export const BRAINSTORM_MARK =
  "M1.10814 72.5347C0.294692 72.1196 -0.056508 71.4658 0.00734648 70.4136C0.0545433 69.7445 0.326619 68.963 1.15534 67.1612C2.71839 63.7005 8.49028 51.2156 10.1005 47.7716C10.8654 46.1447 12.0772 43.5308 12.8116 41.9511C17.2925 32.1925 27.369 10.9859 30.3355 5.06961C31.6584 2.43908 32.0901 1.8172 32.9979 1.37021C33.9391 0.876036 34.7779 0.653378 39.8387 0.413785C52.0382 -0.163682 56.7468 -0.175897 61.5242 0.627004C67.6945 1.66395 71.0122 4.56016 70.9955 9.42282C70.9955 11.9576 70.1987 14.3493 68.508 16.8535C65.765 20.968 61.1258 24.3634 54.4128 27.2021C52.8025 27.8879 52.468 28.0794 52.6262 28.2391C52.6734 28.2863 53.423 28.6056 54.317 28.9401C58.4467 30.5031 60.9815 32.6714 62.4973 35.9238C63.865 38.8584 62.9276 43.9168 62.7041 44.6983C60.9176 50.9005 56.5339 56.3226 50.3622 59.9415C48.8796 60.8021 45.977 62.286 44.7013 62.8274C44.3501 62.9704 43.6963 63.2744 43.266 63.4965C42.819 63.7033 42.3734 63.8796 42.2457 63.8796C41.975 63.8796 39.0572 64.9166 38.4505 65.2344C38.2118 65.3622 37.8453 65.4732 37.6537 65.4732C37.4622 65.4732 37.111 65.5523 36.8569 65.6481C35.677 66.1423 27.1469 68.2786 22.6174 69.2198C17.1328 70.3845 15.8891 70.3525 15.1228 69.0921C14.2136 67.6096 14.8674 65.122 16.3194 64.6112C16.4943 64.5473 18.0893 64.2128 19.8592 63.8616C36.9847 60.5134 46.8543 56.6543 52.3555 51.1851C55.3692 48.1867 57.2182 44.4887 57.2182 41.4584C57.2182 36.1168 51.7489 32.6242 43.3937 32.6242C40.7632 32.6242 38.531 32.9588 34.5915 33.9319C32.1359 34.5371 30.7963 34.6009 30.1744 34.1234C29.3138 33.4863 29.0736 33.0073 29.0736 31.9232C29.0736 31.1098 29.1528 30.8071 29.504 30.2644C29.7594 29.8979 30.1092 29.4995 30.3174 29.3551C30.5243 29.2274 32.3427 28.6861 34.3514 28.1752C40.3939 26.6122 43.0411 25.8307 45.9909 24.7313C55.1277 21.3192 61.3618 17.4921 63.7217 13.8413C65.0293 11.816 65.3319 9.91839 64.5823 8.45113C63.6411 6.63405 61.6158 6.16152 56.5935 5.7784C53.8992 5.57156 36.8042 6.21899 36.4058 6.3467C35.609 6.60212 36.0227 5.8206 28.1936 22.2604C27.2052 24.3176 25.3076 28.3029 23.9681 31.1098C21.8789 35.4949 20.1895 39.1138 17.9088 44.025C13.4765 53.5921 7.38532 66.8266 6.36503 69.0907C5.63209 70.6857 4.86584 72.1516 4.64235 72.3598C4.30781 72.6791 4.05239 72.7262 2.95159 72.7748C1.96324 72.8068 1.51626 72.7429 1.10259 72.5361L1.10814 72.5347Z";

/** The mark's own box, and how tall the line draws it. */
const BOX = { width: 71, height: 73 };
const MARK_HEIGHT = 14;

/**
 * The mark beside the words, in their colour. Brainstorm's design system has a mark this small drawn
 * in one colour, the colour of the text around it: its own two colours turn to mud at this size. The
 * words name it, so a screen reader skips it.
 */
function Mark(): JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${BOX.width} ${BOX.height}`}
      width={(MARK_HEIGHT * BOX.width) / BOX.height}
      height={MARK_HEIGHT}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={BRAINSTORM_MARK} />
    </svg>
  );
}

/**
 * The line's colours, by the ground it is on: the page's (the caption colour the credits have, and
 * the ink when it is pointed at or focused); or the sign-in page's dark ground, which keeps the light
 * theme's colours (that page's caption colour, and its white).
 */
const TONES = {
  page: "text-muted hover:text-ink focus-visible:text-ink",
  night: "text-line-dashed hover:text-ground focus-visible:text-ground",
} as const;

/**
 * "Built on Brainstorm", the quiet line at the foot of every page: Brainstorm's
 * mark, then the words, the whole of it one link to Brainstorm's own site, which opens in a new tab
 * and is told nothing of where the person came from. A caption, with the room a tap needs; underlined
 * only when it is pointed at or focused. It reads nothing and sends nothing: a link is all it is.
 * The shell draws it for the pages that scroll (src/shell/Shell.tsx), and the desktop's list beside
 * the map in its own footer (src/explore/DeskLayout.tsx).
 */
export function BuiltOnBrainstorm({ tone = "page", className = "" }: { tone?: keyof typeof TONES; className?: string }): JSX.Element {
  return (
    <a
      href={config.brainstormSite}
      target="_blank"
      rel="noopener noreferrer"
      // `relative`: the words for a screen reader alone are drawn out of the flow, and are held to the
      // link. Left to the page, they would be placed down the page where the link is in a list that
      // scrolls in its own column (the desktop's list beside the map), and make the window scroll too.
      className={`relative inline-flex min-h-touch items-center gap-1.5 text-caption no-underline hover:underline focus-visible:underline ${TONES[tone]} ${className}`}
    >
      <Mark />
      {copy.common.builtOn}
      <NewTabHint />
    </a>
  );
}
