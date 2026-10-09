import {
  createContext,
  type JSX,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { CheckIcon, CloseIcon, TurningIcon } from "../ui/icons.tsx";
import { type CircleNews, useCircle } from "./CircleProvider.tsx";
import { WHY_PATH } from "./paths.ts";

/*
 * What the person is told of their circle as it happens, quietly (Avi, 2026-10-09): a small bar,
 * centred at the foot of the screen, that says the circle is being worked out, or that a run they
 * started ended in a circle, and goes after 10 s or on its ×; and the check on My circle's half, for a
 * moment, once that run is done. The circle's provider says what there is to tell (`CircleNews`); this
 * says it, once, for the whole app, whatever page the person is on.
 *
 * Nothing is said only here: My circle's half says while the circle is being worked out, and the Why
 * page says how Update now ended. So the bar takes no focus and keeps nothing on screen for long. It is
 * read out through a polite status that is always on the page, empty while there is no bar.
 */

/** How long the bar shows what it says, unless its × puts it away first. */
export const BAR_MS = 10_000;

/** How long My circle's half shows the check once a run the person started ends in a circle. */
export const CHECK_MS = 4_000;

interface NewsValue {
  /** What the bar says now; null while there is no bar. */
  shown: CircleNews | null;
  /** Whether My circle's half shows the check: for `CHECK_MS` once a run the person started ends in a circle. */
  checked: boolean;
  /** Puts the bar away: its ×. */
  close(): void;
}

const NewsContext = createContext<NewsValue>({ shown: null, checked: false, close: () => {} });

/**
 * Times what the circle's provider tells the person (`useCircle().news`), for the bar and for My
 * circle's half below it (`useCircleNews`): each piece of news shows in the bar for `BAR_MS` from when
 * it comes, unless closed or replaced by the next; the end of a run in a circle puts the check on the
 * half for `CHECK_MS`. That the circle is being worked out is said only while it is: a run that ends
 * with no circle takes it away. Update now's end is not said in the bar on the Why page, whose status
 * beside Update now says it, nor again once the person leaves it. It must be inside the router and the
 * circle's provider, and is there for as long as the app is: the shell (src/shell/Shell.tsx).
 */
export function CircleNewsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { news, state } = useCircle();
  const onWhy = useLocation().pathname === WHY_PATH;
  const key = news === null ? null : `${news.run} ${news.what}`;
  // The news whose time in the bar, and whose check, is over.
  const [barDone, setBarDone] = useState<string | null>(null);
  const [checkDone, setCheckDone] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const bar = setTimeout(() => setBarDone(key), BAR_MS);
    const check = setTimeout(() => setCheckDone(key), CHECK_MS);
    return () => {
      clearTimeout(bar);
      clearTimeout(check);
    };
  }, [key]);
  const close = useCallback(() => setBarDone(key), [key]);
  // Update now's end, said beside it on the Why page, is not said in the bar there, nor on the next page.
  if (news?.update === true && onWhy && barDone !== key) setBarDone(key);

  const said = news !== null && barDone !== key && (news.what !== "working" || state === "working");
  const shown = said ? news : null;
  const checked = news !== null && news.what !== "working" && checkDone !== key;
  const value = useMemo<NewsValue>(() => ({ shown, checked, close }), [shown, checked, close]);
  return <NewsContext value={value}>{children}</NewsContext>;
}

/** What the person is told of their circle now. Outside a `CircleNewsProvider`, nothing. */
export function useCircleNews(): NewsValue {
  return useContext(NewsContext);
}

/** What the bar says of `news`: two short lines while the circle is worked out, one once it is done. */
function lines(news: CircleNews): ReactNode {
  if (news.what === "working") {
    return (
      <>
        <p className="m-0 font-bold">{copy.circle.workingTitle}</p>
        <p className="m-0 text-muted">{copy.circle.workingBody}</p>
      </>
    );
  }
  const line = news.what === "recently" ? copy.circle.recently : news.update ? copy.why.updated : copy.circle.ready;
  return <p className="m-0 font-semibold">{line}</p>;
}

/**
 * The bar's ×. Gone with the focus on it (closed, or the bar's time up), it leaves the focus on the
 * bar, which stays on the page, never on the page itself: looked at before the button leaves the page.
 */
function CloseBar({ bar, onClose }: { bar: RefObject<HTMLDivElement | null>; onClose(): void }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node !== null && node === document.activeElement) bar.current?.focus({ preventScroll: true });
    };
  }, [bar]);
  return (
    <button
      ref={button}
      type="button"
      aria-label={copy.circle.closeBar}
      onClick={onClose}
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted"
    >
      <CloseIcon size={18} />
    </button>
  );
}

/**
 * The bar while it shows: a row, as wide as its words need and at most 360 px, inside the phone's
 * gutters; in the ground and shadow of what floats (with its edge, in the dark), with the panel's
 * corners; coming up with a fade, unless the person asks for less motion.
 */
const barLook =
  "flex w-max max-w-[min(360px,calc(100vw-2*var(--gutter-phone)))] items-center gap-3 rounded-panel bg-ground py-1 pr-1 pl-4 text-secondary leading-[1.35] text-ink shadow-float animate-appear motion-reduce:animate-none";

/**
 * The bar (Avi, 2026-10-09): small, centred near the foot of the screen, at most 360 px wide, in the
 * ground and shadow of what floats, with the panel's corners. On a phone it sits clear above the tabs
 * when the page has them (`aboveTabs`); on a desktop, at the bottom centre. It holds a small icon in
 * the trust colour (the arrow, turning while the circle is worked out; the check once it is done), one
 * or two short lines, and its ×. It comes up with a fade, unless the person asks for less motion, and
 * takes no focus. Its polite status is always on the page, empty while there is no bar, which then
 * takes no room and is not drawn.
 */
export function CircleBar({ aboveTabs }: { aboveTabs: boolean }): JSX.Element {
  const { shown, close } = useCircleNews();
  const bar = useRef<HTMLDivElement>(null);
  const place = aboveTabs ? "bottom-[calc(var(--tab-bar-height)+12px)]" : "bottom-4 wide:bottom-6";
  return (
    <div ref={bar} tabIndex={-1} className={`fixed left-1/2 z-30 -translate-x-1/2 outline-none ${place} ${shown === null ? "" : barLook}`}>
      {shown !== null &&
        (shown.what === "working" ? (
          <TurningIcon size={18} className="shrink-0 text-trust animate-turn motion-reduce:animate-breathe" />
        ) : (
          <CheckIcon size={18} className="shrink-0 text-trust" />
        ))}
      <div role="status" className="min-w-0 flex-1">
        {shown !== null && <div key={`${shown.run} ${shown.what}`}>{lines(shown)}</div>}
      </div>
      {shown !== null && <CloseBar bar={bar} onClose={close} />}
    </div>
  );
}
