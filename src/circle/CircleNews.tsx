import {
  createContext,
  type CSSProperties,
  type FocusEvent,
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
 * page says how Update now ended. So the bar takes no focus and keeps nothing on screen for long; its
 * time stands still while the person is at it (the focus or the pointer on it). It is read out through
 * a polite status that is always on the page, empty while there is no bar. A page with controls of its
 * own where the bar would sit keeps it clear of them (`useBarClearOf`).
 */

/** How long the bar shows what it says, unless its × puts it away first: counted while nobody is at it. */
export const BAR_MS = 10_000;

/** How long My circle's half shows the check once a run the person started ends in a circle. */
export const CHECK_MS = 4_000;

/** How far the bar keeps from a page's own controls, in pixels. */
const GAP = 12;

interface NewsValue {
  /** What the bar says now; null while there is no bar. */
  shown: CircleNews | null;
  /** Whether My circle's half shows the check: for `CHECK_MS` once a run the person started ends in a circle. */
  checked: boolean;
  /** When the check came (`Date.now()`'s time): a toggle drawn after it fades it from where it has got to. */
  checkedSince: number;
  /** Puts the bar away: its ×. */
  close(): void;
  /** Stops the bar's time while the person is at it (`true`), and lets it run on from there once they leave. */
  hold(held: boolean): void;
}

const NewsContext = createContext<NewsValue>({ shown: null, checked: false, checkedSince: 0, close: () => {}, hold: () => {} });

/**
 * Controls of a page's own the bar keeps clear of: `above` a footer at the foot of the screen, or
 * `under` what floats at the top of a page whose foot is taken.
 */
interface Room {
  node: HTMLElement;
  side: "above" | "under";
}

const RoomContext = createContext<{ room: Room | null; give(room: Room): () => void }>({ room: null, give: () => () => {} });

/**
 * Times what the circle's provider tells the person (`useCircle().news`), for the bar and for My
 * circle's half below it (`useCircleNews`): each piece of news shows in the bar for `BAR_MS` from when
 * it comes, its time held while the person is at the bar, unless closed or replaced by the next; the
 * end of a run in a circle puts the check on the half for `CHECK_MS`. That the circle is being worked
 * out is said only while it is: a run that ends with no circle takes it away. Update now's end is not
 * said in the bar on the Why page, whose status beside Update now says it, nor again once the person
 * leaves it. It also holds what the page asks the bar to keep clear of (`useBarClearOf`). It must be
 * inside the router and the circle's provider, and is there for as long as the app is: the shell
 * (src/shell/Shell.tsx).
 */
export function CircleNewsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { news, state } = useCircle();
  const onWhy = useLocation().pathname === WHY_PATH;
  const key = news === null ? null : `${news.run} ${news.what}`;
  // When each piece of news came, for the check's fade.
  const [heard, setHeard] = useState<{ key: string | null; at: number }>({ key: null, at: 0 });
  if (heard.key !== key) setHeard({ key, at: Date.now() });

  // The news whose time in the bar, and whose check, is over.
  const [barDone, setBarDone] = useState<string | null>(null);
  const [checkDone, setCheckDone] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const check = setTimeout(() => setCheckDone(key), CHECK_MS);
    return () => clearTimeout(check);
  }, [key]);

  // The bar's time left for the news in it, which stands still while the person is at the bar.
  const [held, setHeld] = useState(false);
  const left = useRef<{ key: string | null; ms: number }>({ key: null, ms: BAR_MS });
  useEffect(() => {
    if (key === null) return;
    if (left.current.key !== key) left.current = { key, ms: BAR_MS };
    if (held) return;
    const from = Date.now();
    const timer = setTimeout(() => setBarDone(key), left.current.ms);
    return () => {
      clearTimeout(timer);
      if (left.current.key === key) left.current.ms = Math.max(0, left.current.ms - (Date.now() - from));
    };
  }, [key, held]);
  const close = useCallback(() => setBarDone(key), [key]);
  const hold = useCallback((on: boolean) => setHeld(on), []);
  // Update now's end, said beside it on the Why page, is not said in the bar there, nor on the next page.
  if (news?.update === true && onWhy && barDone !== key) setBarDone(key);

  const said = news !== null && barDone !== key && (news.what !== "working" || state === "working");
  const shown = said ? news : null;
  const checked = news !== null && news.what !== "working" && checkDone !== key;
  const value = useMemo<NewsValue>(
    () => ({ shown, checked, checkedSince: heard.at, close, hold }),
    [shown, checked, heard.at, close, hold],
  );

  const [room, setRoom] = useState<Room | null>(null);
  const give = useCallback((given: Room) => {
    setRoom(given);
    return () => setRoom((now) => (now === given ? null : now));
  }, []);
  const rooms = useMemo(() => ({ room, give }), [room, give]);
  return (
    <NewsContext value={value}>
      <RoomContext value={rooms}>{children}</RoomContext>
    </NewsContext>
  );
}

/** What the person is told of their circle now. Outside a `CircleNewsProvider`, nothing. */
export function useCircleNews(): NewsValue {
  return useContext(NewsContext);
}

/**
 * Keeps the bar clear of a page's own controls, while the page has them (`node`): `above` a footer at
 * the foot of the screen (the Filters page's Clear all and Show places); or `under` what floats at the
 * top of a page whose foot is taken (the phone's map, whose buttons and docked card are at its foot,
 * and whose search field and toggle are at its top). A page with neither has the bar at the foot.
 */
export function useBarClearOf(node: RefObject<HTMLElement | null>, side: Room["side"]): void {
  const { give } = useContext(RoomContext);
  useLayoutEffect(() => {
    const element = node.current;
    return element === null ? undefined : give({ node: element, side });
  }, [node, side, give]);
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
 * Puts the focus on `node` (the page's main), which takes it for as long as it holds it: it is in the
 * keyboard's order neither before nor after.
 */
function focusFor(node: HTMLElement | null): void {
  if (node === null) return;
  if (!node.hasAttribute("tabindex")) {
    node.setAttribute("tabindex", "-1");
    node.addEventListener("blur", () => node.removeAttribute("tabindex"), { once: true });
  }
  node.focus({ preventScroll: true });
}

/**
 * The bar's ×, which puts it away (`onClose`). Gone with the focus on it (the run ended with no circle,
 * say), it gives the focus back (`giveBack`): looked at before the button leaves the page.
 */
function CloseBar({ onClose, giveBack }: { onClose(): void; giveBack(): void }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  const back = useRef(giveBack);
  useLayoutEffect(() => {
    back.current = giveBack;
  });
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node !== null && node === document.activeElement) back.current();
    };
  }, []);
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
 * Where the bar sits on a page that keeps it clear of its own controls (`useBarClearOf`), measured as
 * they are drawn, and again as they or the window change size; undefined elsewhere, where its classes
 * place it.
 */
function usePlace(room: Room | null): CSSProperties | undefined {
  const [at, setAt] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (room === null) return;
    const place = () => {
      const box = room.node.getBoundingClientRect();
      setAt(room.side === "above" ? { bottom: `${window.innerHeight - box.top + GAP}px` } : { top: `${box.bottom + GAP}px`, bottom: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    // A browser that cannot watch sizes (and jsdom, which lays nothing out) places it again as the window changes.
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    watch?.observe(room.node);
    return () => {
      window.removeEventListener("resize", place);
      watch?.disconnect();
    };
  }, [room]);
  return room === null ? undefined : at;
}

/**
 * The bar (Avi, 2026-10-09): small, centred near the foot of the screen, at most 360 px wide, in the
 * ground and shadow of what floats, with the panel's corners. On a phone it sits clear above the tabs
 * when the page has them (`aboveTabs`), or clear of the page's own controls (`useBarClearOf`); on a
 * desktop, at the bottom centre. It holds a small icon in the trust colour (the arrow, turning while
 * the circle is worked out; the check once it is done), one or two short lines, and its ×. It comes up
 * with a fade, unless the person asks for less motion, and takes no focus. Its time stands still while
 * the focus or the pointer is on it. Put away with the focus in it, it gives the focus back to what had
 * it before, if that is still on the page, else to the page's `main`. Its polite status is always on
 * the page, empty while there is no bar, which then takes no room and is not drawn.
 */
export function CircleBar({ aboveTabs, main }: { aboveTabs: boolean; main: RefObject<HTMLElement | null> }): JSX.Element {
  const { shown, close, hold } = useCircleNews();
  const { room } = useContext(RoomContext);
  const place = usePlace(room);
  const bar = useRef<HTMLDivElement>(null);

  // What had the focus before it came into the bar, to give it back to.
  const before = useRef<Element | null>(null);
  const giveBack = useCallback(() => {
    const to = before.current;
    if (to instanceof HTMLElement && to.isConnected && !bar.current?.contains(to)) to.focus({ preventScroll: true });
    else focusFor(main.current);
  }, [main]);

  // Whether the person is at the bar: its time stands still meanwhile.
  const [focused, setFocused] = useState(false);
  const [pointed, setPointed] = useState(false);
  if (shown === null && (focused || pointed)) {
    setFocused(false);
    setPointed(false);
  }
  const held = shown !== null && (focused || pointed);
  useEffect(() => hold(held), [held, hold]);

  const inside = (event: FocusEvent<HTMLDivElement>) => event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!inside(event)) before.current = event.relatedTarget;
    setFocused(true);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!inside(event)) setFocused(false);
  };
  const putAway = () => {
    if (bar.current?.contains(document.activeElement)) giveBack();
    close();
  };

  const at = aboveTabs ? "bottom-[calc(var(--tab-bar-height)+12px)]" : "bottom-4 wide:bottom-6";
  return (
    <div
      ref={bar}
      style={place}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerEnter={() => setPointed(true)}
      onPointerLeave={() => setPointed(false)}
      className={`fixed left-1/2 z-30 -translate-x-1/2 ${at} ${shown === null ? "" : barLook}`}
    >
      {shown !== null &&
        (shown.what === "working" ? (
          <TurningIcon size={18} className="shrink-0 text-trust animate-turn motion-reduce:animate-breathe" />
        ) : (
          <CheckIcon size={18} className="shrink-0 text-trust" />
        ))}
      <div role="status" className="min-w-0 flex-1">
        {shown !== null && <div key={`${shown.run} ${shown.what}`}>{lines(shown)}</div>}
      </div>
      {shown !== null && <CloseBar onClose={putAway} giveBack={giveBack} />}
    </div>
  );
}
