import { type JSX, type ReactNode, useCallback, useEffect, useId, useMemo } from "react";
import { Link, type To, useLocation, useNavigate } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useWide } from "../shell/useWide.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { cameFrom } from "./returnTo.ts";

/**
 * How the page is left, by "Keep House picks", the cross and Escape: back to the page the person was
 * on, which is one step back in the history when they came from one in the app, so the page is as
 * they left it, with its scroll position, and the history has no sign-in page in it. Where the history
 * has nothing behind this page (a reload, a link opened in a new tab) the page they came from replaces
 * this one, or Explore does when there is none. `to` is where that goes, for the links.
 */
function useLeave(): { to: To; leave(): void } {
  const navigate = useNavigate();
  const { key, state } = useLocation();
  const from = useMemo(() => cameFrom(state), [state]);
  const leave = useCallback(() => {
    if (from !== undefined && key !== "default") void navigate(-1);
    else void navigate(from ?? "/", { replace: true });
  }, [navigate, from, key]);
  return { to: from ?? "/", leave };
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
              tone === "night" ? "bg-ground text-ink" : "bg-ink text-ground"
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

/**
 * "Continue with Nostr". Signing in is not open in M1 (`config.features.signIn`): the button is off,
 * and says why under it, which the button names as its description.
 */
function Continue({ buttonClass, noteClass }: { buttonClass: string; noteClass: string }): JSX.Element {
  const noteId = useId();
  const open = config.features.signIn;
  return (
    <>
      {/* When signing in opens (M2), this starts it. */}
      <button
        type="button"
        disabled={!open}
        aria-describedby={open ? undefined : noteId}
        className={`flex cursor-pointer items-center justify-center rounded-[18px] border-0 font-text font-bold disabled:cursor-not-allowed disabled:opacity-60 ${buttonClass}`}
      >
        {copy.signin.continueButton}
      </button>
      {!open && (
        <p id={noteId} className={`m-0 text-center text-caption leading-[1.45] ${noteClass}`}>
          {copy.signin.comingSoon}
        </p>
      )}
    </>
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

/** The sign-in page on a phone (SignIn.dc.html): the headline and the steps over the dark ground, the buttons at the foot. */
function PhoneSignIn({ to, leave }: { to: To; leave(): void }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col bg-night text-ground">
      <div className="flex justify-end px-3 pt-3.5">
        <LeaveLink to={to} leave={leave} label={copy.signin.close} className="flex size-11 items-center justify-center text-ground">
          <CloseIcon size={22} />
        </LeaveLink>
      </div>
      <section className="flex flex-col gap-3.5 px-6 pt-5">
        <div className="font-display text-[20px] font-extrabold tracking-[-0.01em] text-wordmark-on-night">{copy.app.name}</div>
        <h1 className="m-0 font-display text-[42px] leading-[1.05] font-extrabold tracking-[-0.025em]">{copy.signin.headline}</h1>
        <p className="m-0 text-[17px] leading-[1.5] text-on-night-soft">{copy.signin.intro}</p>
      </section>
      <section className="px-6 pt-[30px]">
        <Steps tone="night" gap="gap-[18px]" />
      </section>
      <section className="mt-auto flex flex-col gap-3 px-6 pt-8 pb-7">
        <Continue buttonClass="h-14 bg-ground text-[17px] text-ink" noteClass="text-line-dashed" />
        <LeaveLink
          to={to}
          leave={leave}
          className="flex h-13 items-center justify-center rounded-[18px] border-token border-muted text-body font-bold text-ground no-underline"
        >
          {copy.signin.keepHousePicks}
        </LeaveLink>
        <p className="m-0 text-center text-caption leading-[1.45] text-line-dashed">{copy.signin.notice}</p>
        <Link
          to="/about#signing-in"
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
function DeskSignIn({ to, leave }: { to: To; leave(): void }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col bg-night text-ground">
      <div className="flex items-center justify-between px-gutter-desktop py-[18px]">
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
          <h1 className="m-0 font-display text-[68px] leading-none font-extrabold tracking-[-0.03em]">{copy.signin.headline}</h1>
          <p className="m-0 max-w-[46ch] text-[19px] leading-[1.5] text-on-night-soft">{copy.signin.intro}</p>
        </section>
        <section className="flex min-w-0 flex-[1_1_380px] flex-col gap-[22px] rounded-dialog bg-ground p-7 text-ink">
          <Steps tone="card" gap="gap-4" textClass="pt-1" />
          <div className="flex flex-col gap-2.5">
            <Continue buttonClass="h-14 bg-accent text-[17px] text-on-accent" noteClass="text-muted" />
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
              to="/about#signing-in"
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
 * Before signing in opens (`config.features.signIn`) it is a display: Continue is off and says so, and
 * Keep House picks, the cross and Escape take the person back to where they were. "Sign in" links
 * across the app lead here, each with the page they were on in `state.from`.
 */
export function SignInPage(): JSX.Element {
  useDocumentTitle(copy.titles.signin);
  const wide = useWide();
  const { to, leave } = useLeave();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) leave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [leave]);

  return wide ? <DeskSignIn to={to} leave={leave} /> : <PhoneSignIn to={to} leave={leave} />;
}
