import { type JSX, type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";
import { Link, type Path } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { retryButton } from "../ui/Banner.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { hasAddOn } from "./addOn.ts";
import { useAddOnSignIn } from "./useAddOnSignIn.ts";

/*
 * Signing in where the person is, with the browser's add-on (decision 23): "Rate this place" and the
 * account button, signed out, are links to the sign-in page that, where the browser has an add-on,
 * ask it at once instead, and the person stays where they are. While it asks, the control is busy
 * and a line says so, with Cancel; the add-on has a minute (src/account/connect.ts). When it says
 * no, fails or does not answer, the line says so, with Try again and the phone's way, which is the
 * sign-in page opened at the code (./returnTo.ts, `wantsPhone`). With no add-on, a new tab, or
 * signing in not open, the link goes to the sign-in page as any link does.
 */

/** Where it is: not begun, the add-on asking, or the add-on having said no (or failed, or not answered). */
export type InlinePhase = "idle" | "asking" | "refused";

/** What a page that signs the person in where they are has: for the control, and for the lines under it. */
export interface InlineSignIn {
  phase: InlinePhase;
  /** The control, a link to the sign-in page, which has the focus back when the lines that had it go. */
  control: RefObject<HTMLAnchorElement | null>;
  /** The link's router state: where the person came from, and where they were going. */
  state: { from: Path; next?: Path };
  /** The control's click: one tap where the browser has an add-on; else the link's own way, to sign in. */
  onClick(event: MouseEvent<HTMLAnchorElement>): void;
  /** Asks the add-on again. */
  retry(): void;
  /** Stops waiting on the add-on. */
  cancel(): void;
}

/** The look of the control while the add-on asks: still there, dimmed, and busy. */
export const BUSY_CONTROL = "aria-busy:cursor-progress aria-busy:opacity-60";

/**
 * Signing in where the person is: `state` is the link's (the page they are on, and the page signing in
 * is for, if any); `onSignedIn` is what happens once the add-on has said who they are.
 */
export function useInlineSignIn(state: { from: Path; next?: Path }, onSignedIn: () => void): InlineSignIn {
  const addOn = useAddOnSignIn();
  const [phase, setPhase] = useState<InlinePhase>("idle");
  const control = useRef<HTMLAnchorElement>(null);
  const backToControl = () => control.current?.focus({ preventScroll: true });

  const ask = () => {
    setPhase("asking");
    void addOn.ask().then((asked) => {
      if (asked === "in") {
        setPhase("idle");
        onSignedIn();
      } else if (asked === "failed") {
        setPhase("refused");
      }
    });
  };

  return {
    phase,
    control,
    state,
    onClick(event) {
      // While the add-on asks, the control does nothing.
      if (phase === "asking") return event.preventDefault();
      if (!isPlainClick(event) || !config.features.signIn || !hasAddOn()) return;
      event.preventDefault();
      ask();
    },
    retry() {
      // Try again goes as the add-on asks: the focus goes to the control, not to the page.
      backToControl();
      ask();
    },
    cancel() {
      addOn.stop();
      setPhase("idle");
      backToControl();
    },
  };
}

/** The add-on said no: said as an alert, with Try again, which has the focus, and the phone's way. */
function Refused({ inline, align }: { inline: InlineSignIn; align: "start" | "end" }): JSX.Element {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retry.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <p role="alert" className={`m-0 text-secondary font-semibold leading-[1.4] text-ink ${align === "end" ? "text-right" : ""}`}>
        {copy.signin.addOnFailed}
      </p>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${align === "end" ? "justify-end" : ""}`}>
        <button ref={retry} type="button" onClick={inline.retry} className={retryButton}>
          {copy.signin.tryAgain}
        </button>
        <Link
          to="/signin"
          state={{ ...inline.state, phone: true }}
          className="inline-flex min-h-touch items-center text-secondary font-semibold text-ink underline hover:text-accent"
        >
          {copy.signin.phoneInstead}
        </Link>
      </div>
    </>
  );
}

/**
 * The lines under the control: nothing until it is pressed; while the add-on asks, a polite line that
 * says so, with Cancel; when it has said no, why, with Try again and the phone's way. `align` puts them
 * under a control at the start of the line, or at its end (the account button).
 */
export function InlineSignInLines({
  inline,
  align = "start",
  className = "",
}: {
  inline: InlineSignIn;
  align?: "start" | "end";
  className?: string;
}): JSX.Element | null {
  if (inline.phase === "idle") return null;
  return (
    <div className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"} ${className}`}>
      {inline.phase === "asking" ? (
        <div className="flex flex-wrap items-center gap-x-3">
          <p role="status" aria-live="polite" className="m-0 text-secondary leading-[1.4] text-muted">
            {copy.signin.waitingForAddOn}
          </p>
          <button
            type="button"
            onClick={inline.cancel}
            className="inline-flex min-h-touch cursor-pointer items-center border-0 bg-transparent p-0 font-text text-secondary font-semibold text-ink underline"
          >
            {copy.signin.cancel}
          </button>
        </div>
      ) : (
        <Refused inline={inline} align={align} />
      )}
    </div>
  );
}
