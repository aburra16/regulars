import { type JSX, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { copy } from "../copy/en.ts";
import { useRelays } from "../score/ScoresProvider.tsx";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import type { Scorer } from "../trust/houseWeights.ts";
import { BackLink } from "../ui/BackLink.tsx";
import { primaryButton, retryButton } from "../ui/Banner.tsx";
import { HouseName } from "../ui/HouseName.tsx";
import { WorkingIcon } from "../ui/icons.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { useCircle } from "./CircleProvider.tsx";
import { type Counted, sizeOfCircle } from "./circleSize.ts";
import { Personalize } from "./Personalize.tsx";

/** The day `date` falls on, on the person's own calendar, as a count of days. */
const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/**
 * When the circle was worked out, at `at` (milliseconds), as of `now`, on the person's calendar, as
 * a review's date is (src/reviews/when.ts): "Worked out 2 days ago". Undefined for a time no date holds.
 */
function workedOutLine(at: number, now: Date): string | undefined {
  const then = new Date(at);
  if (!Number.isFinite(then.getTime())) return undefined;
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  // A month is whole once its day of the month has come round again.
  if (now.getDate() < then.getDate()) months -= 1;
  return copy.why.workedOut(dayOf(now) - dayOf(then), months);
}

/** A floor as it is shown: two figures, the rest rounded down ("2,437" is "2,400+"), so it stays true. */
function shownFloor(n: number): number {
  if (n < 100) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / step) * step;
}

/** Where the count of the circle is. */
type SizeState = { state: "counting" } | { state: "failed" } | ({ state: "counted" } & Counted);

/**
 * The size of `owner`'s circle, whose ranks `scorer` publishes (./circleSize.ts), counted when the
 * panel opens, again on `recount`, and again for each new working-out of it (`edition`, Update now).
 * While it is counted again, the count before stays on screen.
 */
function useCircleSize(owner: string, scorer: Scorer, edition: number): { size: SizeState; recount(): void } {
  const { readers } = useRelays();
  const [attempt, setAttempt] = useState(0);
  const { pubkey, relay } = scorer;
  const key = `${owner} ${pubkey} ${relay} ${edition} ${attempt}`;
  const [result, setResult] = useState<{ key: string; size: SizeState } | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    sizeOfCircle({ owner, scorer: { pubkey, relay }, readers, signal: stop.signal }).then(
      (counted) => {
        if (!stop.signal.aborted) setResult({ key, size: { state: "counted", ...counted } });
      },
      () => {
        if (!stop.signal.aborted) setResult({ key, size: { state: "failed" } });
      },
    );
    return () => stop.abort();
  }, [key, owner, pubkey, relay, readers]);
  const recount = useCallback(() => setAttempt((n) => n + 1), []);
  let size: SizeState = { state: "counting" };
  if (result?.key === key) size = result.size;
  // The count before, for the same circle, while it is counted again.
  else if (result?.size.state === "counted" && result.key.startsWith(`${owner} ${pubkey} ${relay} `)) size = result.size;
  return { size, recount };
}

/** The big number of the circle panel (Trust.dc.html: 54 px; DeskTrust.dc.html: 60 px). */
const bigNumber = "font-display text-score leading-none font-extrabold tracking-[-0.03em] wide:text-[60px]";

/** The circle's count: how many are in it, split by who trusts whom when that is known; or that nobody is yet. */
function Size({ size, onRetry }: { size: SizeState; onRetry(): void }): JSX.Element {
  if (size.state === "counting") return <p className="m-0 text-[15px] font-semibold">{copy.why.counting}</p>;
  const floor = size.state === "counted" && size.size.kind === "atLeast" ? shownFloor(size.size.n) : undefined;
  if (size.state === "failed" || floor === 0) {
    return (
      <div className="flex flex-col items-start gap-2.5">
        <p className="m-0 text-[15px] leading-[1.45]">{copy.why.countFailed}</p>
        <button type="button" onClick={onRetry} className={retryButton}>
          {copy.load.retry}
        </button>
      </div>
    );
  }
  if (size.size.kind === "atLeast") {
    const n = floor ?? 0;
    return (
      <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span aria-hidden="true" className={bigNumber}>
          {copy.why.countAtLeast(n)}
        </span>{" "}
        <span aria-hidden="true" className="text-body font-bold">
          {copy.why.inYourCircle(n)}
        </span>
        <span className="sr-only">{copy.why.atLeast(n)}</span>
      </p>
    );
  }
  const { total, direct, further } = size.size;
  if (total === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="m-0 font-display text-h2 leading-[1.15] font-bold">{copy.why.emptyTitle}</h3>
        <p className="m-0 text-[15px] leading-[1.45]">{copy.why.emptyBody}</p>
      </div>
    );
  }
  return (
    <>
      <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={bigNumber}>{copy.why.count(total)}</span>{" "}
        <span className="text-body font-bold">{copy.why.inYourCircle(total)}</span>
      </p>
      <dl className="m-0 flex flex-col gap-2 text-[15px]">
        <div className="flex justify-between gap-3">
          <dt>{copy.why.youTrust}</dt>
          <dd className="m-0 font-bold">{copy.why.count(direct)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>{copy.why.theyTrust}</dt>
          <dd className="m-0 font-bold">{copy.why.count(further)}</dd>
        </div>
      </dl>
    </>
  );
}

/** A button on the circle panel's tint, in its ink: Update now. */
const panelButton =
  "h-11 shrink-0 cursor-pointer rounded-chip border-token border-trust-ink bg-transparent px-4 font-text text-secondary font-bold text-trust-ink";

/** A quiet button in words, in the panel's ink, 44 px tall: Cancel. */
const panelWordButton =
  "inline-flex min-h-touch cursor-pointer items-center border-0 bg-transparent p-0 font-text text-secondary font-semibold text-trust-ink underline";

/**
 * The person's circle, once it is ready (Trust.dc.html's tinted panel; in DeskTrust.dc.html's side
 * rail): how many are in it, people they trust and people those people trust, when it was worked
 * out, and Update now, whose progress is said in a polite status under it.
 */
function CirclePanel({ owner, scorer, wide }: { owner: string; scorer: Scorer; wide: boolean }): JSX.Element {
  const { account } = useAccount();
  // Update now's run is followed by the circle's provider, above the pages: leaving this page, or the
  // window crossing between the layouts, stops nothing.
  const { updateStep: step, update, cancel, edition } = useCircle();
  const { size, recount } = useCircleSize(owner, scorer, edition);
  const now = useNow();
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  const workedOut = size.state === "counted" && size.workedOut !== undefined ? workedOutLine(size.workedOut, now) : undefined;

  /** Runs `act`, with the focus on the panel first: the button pressed is about to go. */
  const fromPanel = (act: () => void) => () => {
    panel.current?.focus({ preventScroll: true });
    act();
  };

  let message: ReactNode = null;
  switch (step) {
    case "signing":
      message = account?.how === "phone" ? copy.circle.approvePhone : copy.circle.approveBrowser;
      break;
    case "updating":
      message = (
        <>
          <WorkingIcon size={18} className="shrink-0 text-trust" />
          {copy.why.updating}
        </>
      );
      break;
    case "started":
      message = copy.why.updateStarted;
      break;
    case "recently":
      message = copy.circle.recently;
      break;
    case "updated":
      message = copy.why.updated;
      break;
    case "failed":
      message = copy.why.updateFailed;
      break;
    case "idle":
      break;
  }

  let action: ReactNode = null;
  if (step === "signing") {
    action = (
      <button type="button" onClick={fromPanel(cancel)} className={panelWordButton}>
        {copy.circle.cancel}
      </button>
    );
  } else if (step !== "updating") {
    action = (
      <button type="button" onClick={fromPanel(update)} className={panelButton}>
        {copy.why.updateNow}
      </button>
    );
  }

  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={`flex flex-col gap-3.5 bg-trust-tint text-trust-ink outline-none ${wide ? "rounded-[24px] p-[22px]" : "rounded-panel p-[18px]"}`}
    >
      <h2 id={headingId} className="sr-only">
        {copy.why.circleHeading}
      </h2>
      <Size size={size} onRetry={recount} />
      <div className="flex flex-col">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
          {workedOut !== undefined && <p className="m-0 text-caption">{workedOut}</p>}
          {action}
        </div>
        {/* Always there, so a screen reader hears each change. Empty, it takes no room. */}
        <div role="status" className="*:mt-2.5">
          {message !== null && <p className="m-0 flex items-center gap-2 text-secondary leading-[1.4] font-semibold">{message}</p>}
        </div>
      </div>
    </section>
  );
}

/**
 * The circle panel's place before the circle is ready (the signed-out version is not drawn): what My
 * circle is, beside House picks (below), and the way to it: Sign in, which can bring the person back
 * here; or, signed in, Personalize, with the line that says what it does, and its progress.
 */
function ViewsPanel({ signedOut, wide }: { signedOut: boolean; wide: boolean }): JSX.Element {
  const location = useLocation();
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={`flex flex-col gap-3 border-token border-line outline-none ${wide ? "rounded-[24px] p-[22px]" : "rounded-panel p-[18px]"}`}
    >
      <h2 id={headingId} className="m-0 font-display text-h2 font-bold">
        {copy.view.circle}
      </h2>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-soft">{signedOut ? copy.signin.intro : copy.why.housePicksNow}</p>
      {signedOut ? (
        <Link to="/signin" state={{ from: location }} className={`self-start ${primaryButton}`}>
          {copy.signin.button}
        </Link>
      ) : (
        <Personalize holdFocus={panel} />
      )}
    </section>
  );
}

/** The panel for the person: their circle once it is ready, else the views and the way to My circle. */
function YoursPanel({ wide }: { wide: boolean }): JSX.Element {
  const { account, restoring } = useAccount();
  const circle = useCircle();
  if (account !== undefined && circle.ready && circle.scorer !== undefined) {
    const { pubkey, relay } = circle.scorer;
    return <CirclePanel key={`${account.pubkey} ${pubkey} ${relay}`} owner={account.pubkey} scorer={circle.scorer} wide={wide} />;
  }
  return <ViewsPanel signedOut={account === undefined && !restoring} wide={wide} />;
}

/** The toggle, with the words over it. On a desktop it is as wide as its two halves need. */
function LookingThrough({ wide }: { wide: boolean }): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-body font-bold">{copy.why.lookingThrough}</p>
      <div className={wide ? "w-[340px] max-w-full" : undefined}>
        <ViewSwitch variant="bar" />
      </div>
    </div>
  );
}

/**
 * The three rules (`copy.why.rules`), numbered: on a phone, each a line with its title as a sentence
 * (Trust.dc.html); on a desktop, cards side by side (DeskTrust.dc.html). The figures are the list's
 * own numbers, drawn, so a screen reader hears the list's.
 */
function Rules({ wide }: { wide: boolean }): JSX.Element {
  const headingId = useId();
  const rules = [copy.why.rules.only, copy.why.rules.closer, copy.why.rules.oneSay];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className={`m-0 font-display font-bold ${wide ? "text-[26px]" : "text-h2"}`}>
        {copy.why.rulesHeading}
      </h2>
      {/* role="list": a list styled without markers is still a list to every screen reader. */}
      <ol
        role="list"
        aria-labelledby={headingId}
        className={`m-0 list-none p-0 ${wide ? "grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3.5" : "flex flex-col gap-4"}`}
      >
        {rules.map((rule, i) => (
          <li
            key={rule.title}
            className={wide ? "flex flex-col gap-2.5 rounded-card border-token border-line p-[18px]" : "flex items-start gap-3.5"}
          >
            <span
              aria-hidden="true"
              className="flex size-8 flex-none items-center justify-center rounded-full bg-emphasis font-extrabold text-on-emphasis"
            >
              {i + 1}
            </span>
            {wide ? (
              <>
                <p className="m-0 text-[17px] font-bold">{rule.title}</p>
                <p className="m-0 text-[15px] leading-[1.45] text-ink-soft">{rule.body}</p>
              </>
            ) : (
              <p className="m-0 text-body leading-[1.45]">
                <strong className="font-bold">{copy.common.sentence(rule.title)}</strong> {rule.body}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A box of words with a small heading: what is folded away (dashed), and House picks (grey). */
function Aside({ heading, kind, wide, children }: { heading: string; kind: "dashed" | "grey"; wide: boolean; children: ReactNode }) {
  const headingId = useId();
  const look =
    kind === "dashed"
      ? `rounded-card border-token border-dashed border-line-dashed ${wide ? "p-[18px]" : "p-4"}`
      : `bg-surface p-[18px] ${wide ? "rounded-card" : "rounded-panel"}`;
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-2 ${look}`}>
      <h2 id={headingId} className="m-0 font-text text-body font-bold">
        {heading}
      </h2>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-soft">{children}</p>
    </section>
  );
}

function Folded({ wide }: { wide: boolean }): JSX.Element {
  return (
    <Aside heading={copy.why.foldedHeading} kind="dashed" wide={wide}>
      {wide ? copy.why.foldedBodyDesk : copy.why.foldedBody}
    </Aside>
  );
}

function HousePicks({ wide }: { wide: boolean }): JSX.Element {
  return (
    <Aside heading={copy.why.houseHeading} kind="grey" wide={wide}>
      <HouseName text={wide ? copy.why.houseBodyDesk : copy.why.houseBody} size="line" />
    </Aside>
  );
}

function AboutLink(): JSX.Element {
  return (
    <Link to="/about" className="inline-flex min-h-touch items-center self-start text-secondary font-semibold text-ink underline hover:text-accent">
      {copy.why.about}
    </Link>
  );
}

/** The phone's page (Trust.dc.html): one column, the circle panel under the toggle. */
function PhoneWhy(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col pb-6">
      <div className="px-3 pt-3.5">
        <BackLink wide={false} back={copy.about.back} />
      </div>
      <div className="flex flex-col gap-2.5 px-gutter-phone pt-2">
        <h1 className="m-0 font-display text-display-phone leading-[1.08] font-extrabold tracking-display">{copy.why.title}</h1>
        <p className="m-0 text-body leading-[1.5] text-ink-soft">{copy.why.intro}</p>
      </div>
      <div className="flex flex-col gap-[18px] px-gutter-phone pt-[22px]">
        <LookingThrough wide={false} />
        <YoursPanel wide={false} />
      </div>
      <div className="flex flex-col gap-6 px-gutter-phone pt-[26px]">
        <Rules wide={false} />
        <Folded wide={false} />
        <HousePicks wide={false} />
      </div>
      <div className="mt-auto px-gutter-phone pt-[18px]">
        <AboutLink />
      </div>
    </div>
  );
}

/**
 * The desktop's page (DeskTrust.dc.html): the explanation on the left, with the rules as cards in a
 * row; the circle, or the way to it, in a side rail, which goes under the explanation in a narrow window.
 */
function DeskWhy(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-content flex-wrap items-start gap-x-14 gap-y-9 px-gutter-desktop pt-10 pb-14">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[30px]">
        <div className="flex flex-col gap-3.5">
          <h1 className="m-0 font-display text-[48px] leading-[1.04] font-extrabold tracking-[-0.025em]">{copy.why.title}</h1>
          <p className="m-0 max-w-[58ch] text-[18px] leading-[1.5] text-ink-soft">{copy.why.intro}</p>
        </div>
        <LookingThrough wide />
        <Rules wide />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3.5">
          <Folded wide />
          <HousePicks wide />
        </div>
      </div>
      <aside aria-label={copy.why.circleHeading} className="flex min-w-0 flex-[1_1_340px] flex-col gap-[22px]">
        <YoursPanel wide />
        <AboutLink />
      </aside>
    </div>
  );
}

/**
 * Why you see what you see (the brief's screen 12, D4), at `/why`: there is no single score for a
 * place; the toggle; the person's circle in a count, when it was worked out, and Update now; the three
 * rules; what gets folded away; and House picks. Signed out, or before the circle is worked out, the
 * circle's place says what My circle is and offers Sign in or Personalize. The people the person
 * trusts, each with Remove, come with the Trust button and its safeguards (the brief's § 7): not here.
 * No number on a person anywhere (decision 19): the circle is a count of people.
 */
export function WhyPage(): JSX.Element {
  useDocumentTitle(copy.titles.why);
  return useWide() ? <DeskWhy /> : <PhoneWhy />;
}
