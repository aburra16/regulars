import { type JSX, type ReactNode, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, type To, useLocation, useNavigate } from "react-router-dom";

import { aboutAt, SIGNING_IN } from "../about/anchors.ts";
import { useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useWide } from "../shell/useWide.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { ADD_ON_WAIT_MS, hasAddOn, lookForAddOn, msSinceLoad } from "./addOn.ts";
import { loadPhoneWay } from "./loadPhoneWay.ts";
import type { PhoneWay as PhoneWayPanel, Tone } from "./PhoneWay.tsx";
import { cameFrom, goingTo, landingFrom, wantsPhone } from "./returnTo.ts";
import { useAddOnSignIn } from "./useAddOnSignIn.ts";

/**
 * How the page is left, by "Keep House picks", the cross and Escape, and once the person is signed
 * in: back to the page the person was on, which is one step back in the history when they came from
 * one in the app, so the page is as they left it, with its scroll position, and the history has no
 * sign-in page in it. Where the history has nothing behind this page (a reload, a link opened in a
 * new tab) the page they came from replaces this one, or Explore does when there is none, for a person
 * who leaves as for one who has signed in: never a page of its own (decision 23). `to` is where the
 * links go.
 *
 * `signedIn` is how it is left once the person has signed in: on to the page they were on their way
 * to, when the link that sent them here names one (`goingTo`), in place of this page; else as `leave`,
 * except from a page that only asked them to sign in (You, Saved: `landingFrom`), which has nothing
 * more for them, and Explore replaces this page. The page they came from stays behind it, as the way
 * back from there.
 */
function useLeave(): { to: To; leave(): void; signedIn(): void } {
  const navigate = useNavigate();
  const { key, state } = useLocation();
  const from = useMemo(() => cameFrom(state), [state]);
  const next = useMemo(() => goingTo(state), [state]);
  const leave = useCallback(() => {
    if (from !== undefined && key !== "default") void navigate(-1);
    else void navigate(from ?? "/", { replace: true });
  }, [navigate, from, key]);
  const landing = useMemo(() => landingFrom(state), [state]);
  const signedIn = useCallback(() => {
    if (next === undefined && landing === undefined) return void navigate("/", { replace: true });
    if (next === undefined) return leave();
    // The page behind this one, if there is one, is where the next page goes back to.
    void navigate(next, { replace: true, state: from !== undefined && key !== "default" ? { from } : undefined });
  }, [navigate, leave, next, landing, from, key]);
  return { to: from ?? "/", leave, signedIn };
}

/**
 * The three steps, numbered. `tone` is how the numbers look: white on the dark page, dark on the
 * white card. The numbers are for the eye; the list says "1 of 3" to a screen reader.
 */
function Steps({ tone, gap, textClass = "" }: { tone: "night" | "card"; gap: string; textClass?: string }): JSX.Element {
  return (
    <ol role="list" aria-label={copy.signin.stepsLabel} className={`m-0 flex list-none flex-col p-0 ${gap}`}>
      {copy.signin.steps.map((text, i) => (
        <li key={text} className="flex items-start gap-3.5">
          <span
            aria-hidden="true"
            className={`flex size-8 shrink-0 items-center justify-center rounded-full font-extrabold ${
              tone === "night" ? "bg-ground text-ink" : "bg-emphasis text-on-emphasis"
            }`}
          >
            {i + 1}
          </span>
          <span className={`min-w-0 text-body leading-[1.45] ${textClass}`}>{text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The look of Continue's button, and of the button in its place. */
const BUTTON =
  "flex cursor-pointer items-center justify-center rounded-[18px] border-0 font-text font-bold aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/** A button in words, under Continue: "Use an app on your phone instead", or Cancel. */
function TextButton({ className, onClick, children }: { className: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-touch cursor-pointer items-center justify-center self-center border-0 bg-transparent px-3 font-text text-secondary font-semibold underline ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * What Continue began did not work: said as an alert, with Try again, which has the focus, and what
 * else there is to do (`children`). The page stays, with its way back.
 */
function Failed({
  message,
  buttonClass,
  textClass,
  onRetry,
  children,
}: {
  message: string;
  buttonClass: string;
  textClass: string;
  onRetry(): void;
  children?: ReactNode;
}): JSX.Element {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retry.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <p role="alert" className={`m-0 text-center text-body font-semibold leading-[1.45] ${textClass}`}>
        {message}
      </p>
      <button ref={retry} type="button" onClick={onRetry} className={`${BUTTON} ${buttonClass}`}>
        {copy.signin.tryAgain}
      </button>
      {children}
    </>
  );
}

/**
 * Whether the browser has an add-on to sign in with, as the page has looked since it opened: undefined
 * while it looks (an add-on may put itself on the page a moment after it loads: `lookForAddOn`), then
 * yes or no. A page that loaded more than `ADD_ON_WAIT_MS` ago (one reached by a link in the app) has
 * its answer at once: no look. `known` gives the answer, once there is one; undefined when the page
 * has gone, and nothing is to be done with it.
 */
function useAddOn(): { present: boolean | undefined; known(): Promise<boolean | undefined> } {
  const [present, setPresent] = useState<boolean | undefined>(() =>
    hasAddOn() ? true : msSinceLoad() >= ADD_ON_WAIT_MS ? false : undefined,
  );
  const looking = useRef<Promise<boolean | undefined> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const look = lookForAddOn(controller.signal).then((found) => (controller.signal.aborted ? undefined : found));
    looking.current = look;
    void look.then((found) => {
      if (found !== undefined) setPresent(found);
    });
    return () => controller.abort();
  }, []);
  const known = useCallback(() => looking.current ?? Promise.resolve(hasAddOn()), []);
  return { present, known };
}

/**
 * Where Continue is: its button (`focus`: given back to it, by Cancel); looking, for a moment, for an
 * add-on; the add-on asking the person; the add-on having said no; the phone's way being fetched,
 * open, or not fetched.
 */
type Step =
  | { at: "button"; focus: boolean }
  | { at: "looking" }
  | { at: "asking" }
  | { at: "refused" }
  | { at: "fetching" }
  | { at: "phone"; Panel: typeof PhoneWayPanel }
  | { at: "not fetched" };

/**
 * "Continue with Nostr", one tap where it can be (decision 23). Where the browser has an add-on, it
 * asks it at once who the person is (the add-on may ask them first), and "Use an app on your phone
 * instead" is under it. Where it has none, it opens the phone's way at once (./PhoneWay.tsx): the
 * code, the link, and on a phone "Open the app"; on a desktop, with the line on how to get an add-on
 * under it. Pressed before the page has finished looking for an add-on that comes late, it says it is
 * looking, for at most half a second, and then goes one way: the phone's way is never shown and then
 * taken away. When the add-on says no, fails or does not answer in a minute, it says so, with Try
 * again and the phone's way. A link that asks for the phone's way (`wantsPhone`: "Use an app on your
 * phone instead" where the add-on did not work, on a place's page or at the account button) opens it
 * at once.
 * While anything is under way the button stays, off and busy, with the focus: drawn in its place,
 * nothing would have it, and a keyboard or a screen reader would be sent back to the page's top. When
 * what had the focus has gone (Try again, "Use an app on your phone instead"), the button takes it.
 * A person signed in, or about to be (a session this tab kept being restored), has nothing to
 * continue to, and does not see it: the page takes them on. While signing in is not open
 * (`config.features.signIn`), the button is off, and says why under it, which the button names as its
 * description. It is off with `aria-disabled` and not `disabled`, so that it stays where the keyboard
 * goes and a screen reader reads its note.
 */
function Continue({
  tone,
  buttonClass,
  noteClass,
  textClass,
}: {
  tone: Tone;
  buttonClass: string;
  noteClass: string;
  textClass: string;
}): JSX.Element | null {
  const noteId = useId();
  const open = config.features.signIn;
  const { account, restoring } = useAccount();
  const { state } = useLocation();
  const addOn = useAddOn();
  const asking = useAddOnSignIn();
  const [phoneFirst] = useState(() => open && wantsPhone(state));
  const [step, setStep] = useState<Step>(() => (phoneFirst ? { at: "fetching" } : { at: "button", focus: false }));
  const button = useRef<HTMLButtonElement>(null);

  const giveFocus = step.at === "button" && step.focus;
  useEffect(() => {
    if (giveFocus) button.current?.focus({ preventScroll: true });
  }, [giveFocus]);

  // Busy, the button keeps the focus, or takes it when what had it has gone.
  const busy = step.at === "looking" || step.at === "asking" || step.at === "fetching";
  useEffect(() => {
    if (!busy) return;
    const active = document.activeElement;
    if (active === null || active === document.body) button.current?.focus({ preventScroll: true });
  }, [busy, step.at]);

  const askAddOn = () => {
    setStep({ at: "asking" });
    void asking.ask().then((asked) => {
      // Signed in, the page takes the person on; stopped, whatever stopped it has said where Continue is.
      if (asked === "failed") setStep({ at: "refused" });
    });
  };
  const openPhone = () => {
    asking.stop();
    setStep({ at: "fetching" });
    loadPhoneWay().then(
      ({ PhoneWay }) => setStep({ at: "phone", Panel: PhoneWay }),
      () => setStep({ at: "not fetched" }),
    );
  };
  const choose = () => {
    if (hasAddOn()) return askAddOn();
    if (addOn.present === false) return openPhone();
    setStep({ at: "looking" });
    void addOn.known().then((found) => {
      // The page has gone while it looked: nothing is asked of an add-on that comes after.
      if (found === undefined) return;
      if (found || hasAddOn()) askAddOn();
      else openPhone();
    });
  };

  // A link that asked for the phone's way: it opens now. Once, though the effect may run twice.
  const openedFirst = useRef(false);
  useEffect(() => {
    if (!phoneFirst || openedFirst.current) return;
    openedFirst.current = true;
    openPhone();
  });
  const cancel = () => {
    asking.stop();
    setStep({ at: "button", focus: true });
  };
  // An add-on that came after the page looked is one all the same.
  const withAddOn = addOn.present === true || hasAddOn();

  if (account !== undefined || restoring) return null;
  if (step.at === "phone") {
    return (
      <>
        <step.Panel tone={tone} onCancel={cancel} />
        {/* A phone's browser seldom takes an add-on: the line is for a desktop's. */}
        {tone === "card" && !withAddOn && (
          <p className={`m-0 text-center text-caption leading-[1.45] ${noteClass}`}>{copy.signin.noAddOn}</p>
        )}
      </>
    );
  }
  if (step.at === "not fetched") {
    return <Failed message={copy.signin.failed} buttonClass={buttonClass} textClass={textClass} onRetry={openPhone} />;
  }
  if (step.at === "refused") {
    return (
      <Failed message={copy.signin.addOnFailed} buttonClass={buttonClass} textClass={textClass} onRetry={askAddOn}>
        <TextButton className={textClass} onClick={openPhone}>
          {copy.signin.phoneInstead}
        </TextButton>
      </Failed>
    );
  }
  const off = !open || busy;
  const said = step.at === "looking" ? copy.signin.lookingForAddOn : step.at === "asking" ? copy.signin.browserWaiting : "";
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-disabled={off ? true : undefined}
        aria-busy={busy ? true : undefined}
        aria-describedby={open ? undefined : noteId}
        // While it is off it does nothing.
        onClick={off ? (event) => event.preventDefault() : choose}
        className={`${BUTTON} ${buttonClass}`}
      >
        {copy.signin.continueButton}
      </button>
      {!open && (
        <p id={noteId} className={`m-0 text-center text-caption leading-[1.45] ${noteClass}`}>
          {copy.signin.comingSoon}
        </p>
      )}
      <p role="status" className={said === "" ? "sr-only" : `m-0 text-center text-body leading-[1.45] ${textClass}`}>
        {said}
      </p>
      {step.at === "asking" && (
        <TextButton className={textClass} onClick={cancel}>
          {copy.signin.cancel}
        </TextButton>
      )}
      {open && step.at === "button" && withAddOn && (
        <TextButton className={textClass} onClick={openPhone}>
          {copy.signin.phoneInstead}
        </TextButton>
      )}
    </>
  );
}

/** The page's headline, which has the focus when the page opens, so a screen reader starts there. It is not a control: no ring. */
function Headline({ headlineRef, className }: { headlineRef: RefObject<HTMLHeadingElement | null>; className: string }): JSX.Element {
  return (
    <h1 ref={headlineRef} tabIndex={-1} className={`m-0 font-display font-extrabold outline-none ${className}`}>
      {copy.signin.headline}
    </h1>
  );
}

/** A link that leaves the page: a plain click goes by `leave`, any other (a new tab) by the link's own address. */
function LeaveLink({
  to,
  leave,
  className,
  label,
  children,
}: {
  to: To;
  leave(): void;
  className: string;
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Link
      to={to}
      aria-label={label}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        leave();
      }}
      className={className}
    >
      {children}
    </Link>
  );
}

/** What each layout of the page is given: where it leaves to, how, and the headline to focus. */
interface LayoutProps {
  to: To;
  leave(): void;
  headlineRef: RefObject<HTMLHeadingElement | null>;
}

/** The sign-in page on a phone (SignIn.dc.html): the headline and the steps over the dark ground, the buttons at the foot. */
function PhoneSignIn({ to, leave, headlineRef }: LayoutProps): JSX.Element {
  return (
    <div data-theme="light" className="on-dark flex flex-1 flex-col bg-night text-ground">
      <div className="flex justify-end px-3 pt-3.5">
        <LeaveLink to={to} leave={leave} label={copy.signin.close} className="flex size-11 items-center justify-center text-ground">
          <CloseIcon size={22} />
        </LeaveLink>
      </div>
      <section className="flex flex-col gap-3.5 px-6 pt-5">
        <div className="font-display text-[20px] font-extrabold tracking-[-0.01em] text-wordmark-on-night">{copy.app.name}</div>
        <Headline headlineRef={headlineRef} className="text-[42px] leading-[1.05] tracking-[-0.025em]" />
        <p className="m-0 text-[17px] leading-[1.5] text-on-night-soft">{copy.signin.intro}</p>
      </section>
      <section className="px-6 pt-[30px]">
        <Steps tone="night" gap="gap-[18px]" />
      </section>
      <section className="mt-auto flex flex-col gap-3 px-6 pt-3 pb-7">
        <Continue tone="night" buttonClass="h-14 bg-ground text-[17px] text-ink" noteClass="text-line-dashed" textClass="text-ground" />
        <LeaveLink
          to={to}
          leave={leave}
          className="flex h-13 items-center justify-center rounded-[18px] border-token border-muted text-body font-bold text-ground no-underline"
        >
          {copy.signin.keepHousePicks}
        </LeaveLink>
        <p className="m-0 text-center text-caption leading-[1.45] text-line-dashed">{copy.signin.notice}</p>
        <Link
          to={aboutAt(SIGNING_IN)}
          className="flex min-h-touch items-center justify-center text-secondary font-semibold text-ground underline"
        >
          {copy.signin.howItWorks}
        </Link>
      </section>
    </div>
  );
}

/**
 * The sign-in page on a desktop (DeskSignIn.dc.html): the wordmark and the cross over the dark
 * ground, the headline on the left, and on the right a white card with the steps, the buttons and the
 * notice. Where the window is too narrow for the two side by side, the card goes under the headline.
 */
function DeskSignIn({ to, leave, headlineRef }: LayoutProps): JSX.Element {
  return (
    <div data-theme="light" className="flex flex-1 flex-col bg-night text-ground">
      <div className="on-dark flex items-center justify-between px-gutter-desktop py-[18px]">
        <Link
          to="/"
          className="font-display text-[26px] font-extrabold tracking-display text-wordmark-on-night no-underline"
        >
          {copy.app.name}
        </Link>
        <LeaveLink to={to} leave={leave} label={copy.signin.close} className="flex size-11 items-center justify-center text-ground">
          <CloseIcon size={22} />
        </LeaveLink>
      </div>
      <div className="mx-auto flex w-full max-w-content flex-1 flex-wrap items-center gap-x-[72px] gap-y-10 px-gutter-desktop pt-6 pb-16">
        <section className="flex min-w-0 flex-[999_1_460px] flex-col gap-5">
          <Headline headlineRef={headlineRef} className="text-[68px] leading-none tracking-[-0.03em]" />
          <p className="m-0 max-w-[46ch] text-[19px] leading-[1.5] text-on-night-soft">{copy.signin.intro}</p>
        </section>
        <section className="flex min-w-0 flex-[1_1_380px] flex-col gap-[22px] rounded-dialog bg-ground p-7 text-ink">
          <Steps tone="card" gap="gap-4" textClass="pt-1" />
          <div className="flex flex-col gap-2.5">
            <Continue tone="card" buttonClass="h-14 bg-accent-solid text-[17px] text-on-accent" noteClass="text-muted" textClass="text-ink" />
            <LeaveLink
              to={to}
              leave={leave}
              className="flex h-13 items-center justify-center rounded-[18px] border-token border-field-border text-body font-bold text-ink no-underline"
            >
              {copy.signin.keepHousePicks}
            </LeaveLink>
          </div>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-caption leading-[1.45] text-muted">{copy.signin.notice}</p>
            <Link
              to={aboutAt(SIGNING_IN)}
              className="inline-flex min-h-touch items-center self-start text-secondary font-semibold text-ink underline hover:text-accent"
            >
              {copy.signin.howItWorks}
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The sign-in page (screens 10 and D6), at `/signin`: a dark page of its own, with no top bar or tabs.
 * It is the same in both themes: each layout keeps the light theme's colours (`data-theme="light"`),
 * which on its dark ground are the ones it was drawn in.
 * Continue signs the person in, one tap where it can be (`Continue`); once they are signed in, as when
 * they Keep House picks, close it or press Escape, they go back to where they were (or to Explore when
 * the page does not know), unless the link that sent them names where they were going: signed in, they
 * go on there (Rate this place's review form). A person already signed in is taken back at once. "Sign in" links across the
 * app lead here, each with the page they were on in `state.from`. Before signing in opens
 * (`config.features.signIn`) it is a display: Continue is off and says so.
 */
export function SignInPage(): JSX.Element {
  useDocumentTitle(copy.titles.signin);
  const wide = useWide();
  const { to, leave, signedIn } = useLeave();
  const { account } = useAccount();
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const left = useRef(false);

  // The page opens at its headline: a screen reader reads the page from there, and the keyboard starts above the buttons.
  useEffect(() => {
    headlineRef.current?.focus({ preventScroll: true });
  }, []);

  // The phone's way is fetched now. If it cannot be, Continue tries again.
  useEffect(() => {
    if (config.features.signIn) loadPhoneWay().catch(() => {});
  }, []);

  // Once the person is signed in, here or before they came, the page takes them on to where they were
  // going, or back where they were, or to Explore. Once: the effect may run again before the page is gone.
  useEffect(() => {
    if (account === undefined || left.current) return;
    left.current = true;
    signedIn();
  }, [account, signedIn]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) leave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [leave]);

  return wide ? (
    <DeskSignIn to={to} leave={leave} headlineRef={headlineRef} />
  ) : (
    <PhoneSignIn to={to} leave={leave} headlineRef={headlineRef} />
  );
}
