import { type FormEvent, type JSX, type RefObject, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useConnect } from "../account/AccountProvider.tsx";
import { copy } from "../copy/en.ts";
import { isHandheld } from "./handheld.ts";
import { QrCode } from "./QrCode.tsx";

/*
 * Signing in with an app on the person's phone, on the sign-in page: a code to scan and a link to
 * copy (NIP-46's nostrconnect), or a link the phone app gives, pasted (bunker). "Continue with Nostr"
 * opens it at once where the browser has no add-on to sign in with, and "Use an app on your phone
 * instead" where it has (decision 23; the add-on's way is the sign-in page's own,
 * ./useAddOnSignIn.ts). This module, with the QR code's library, is a chunk the sign-in page loads
 * (./loadPhoneWay.ts); the signing code loads when it opens (src/account/AccountProvider.tsx). Once
 * the person is signed in, the sign-in page takes them on.
 */

/** The ground the panel is on: the phone's dark page, or the white card on a desktop (SignIn.dc.html, DeskSignIn.dc.html). */
export type Tone = "night" | "card";

/** The colours of each part on each ground, the sign-in page's own. */
interface Look {
  /** A button that goes on: white on the dark page, as Continue is; the accent on the card. */
  primary: string;
  /** A button beside the way on: outlined, as Keep House picks is. */
  secondary: string;
  /** Words to read. */
  text: string;
  /** A note under them. */
  note: string;
  /** The field for a link. */
  field: string;
  /** The light square the code is drawn on, which a scanner needs around it. */
  code: string;
}

const LOOK: Record<Tone, Look> = {
  night: {
    primary: "border-0 bg-ground text-ink",
    secondary: "border-token border-muted bg-transparent text-ground",
    text: "text-ground",
    note: "text-line-dashed",
    field: "border-0 bg-ground text-ink",
    code: "",
  },
  card: {
    primary: "border-0 bg-accent-solid text-on-accent",
    secondary: "border-token border-field-border bg-transparent text-ink",
    text: "text-ink",
    note: "text-muted",
    field: "border-token border-field-border bg-ground text-ink",
    code: "border-token border-line",
  },
};

/** The size of a button that goes on, as Continue's (SignIn.dc.html). */
const BIG = "flex h-14 w-full cursor-pointer items-center justify-center rounded-[18px] font-text text-[17px] font-bold";

/** The size of a smaller button beside a field or under the code. */
const SMALL = "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-button px-4 font-text text-body font-bold";

/** Puts the focus on `ref`'s element once it is drawn, so a screen reader reads on from there. */
function useFocusOnMount(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [ref]);
}

/** "Cancel": stops what is under way and gives Continue back. */
function CancelButton({ look, onCancel }: { look: Look; onCancel(): void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onCancel}
      className={`flex min-h-touch cursor-pointer items-center justify-center self-center border-0 bg-transparent px-3 font-text text-secondary font-semibold underline ${look.text}`}
    >
      {copy.signin.cancel}
    </button>
  );
}

/**
 * Signing in with an app on the phone: a code to scan and a link to copy, which the app waits on from
 * when it is drawn, and on a phone or a tablet a link that opens the app on it; and a field for a link
 * from the phone app, which stops the wait and connects with that instead. One way at a time; each ends
 * when the panel goes (`Cancel`, or the page left).
 */
function PhonePanel({ look, onFailed, onCancel }: { look: Look; onFailed(): void; onCancel(): void }): JSX.Element {
  const connect = useConnect();
  // On a phone or a tablet, judged by the device and not the window's width (`isHandheld`), the person
  // is likely on the device their app is on, which cannot scan its own screen: "Open the app" goes to
  // the app with the link. A computer's window, however narrow, has the code to scan.
  const [handheld] = useState(isHandheld);
  const fieldId = useId();
  const said = useRef<HTMLParagraphElement>(null);
  useFocusOnMount(said);
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const [pasted, setPasted] = useState("");
  const [pasting, setPasting] = useState(false);
  const scanning = useRef<AbortController | null>(null);
  const pastingRef = useRef<AbortController | null>(null);
  const failed = useEffectEvent(onFailed);

  useEffect(() => {
    const controller = new AbortController();
    scanning.current = controller;
    connect
      .phone((uri) => {
        if (!controller.signal.aborted) setLink(uri);
      }, controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) failed();
      });
    return () => {
      controller.abort();
      pastingRef.current?.abort();
    };
  }, [connect]);

  const copyLink = async () => {
    if (link === undefined || pasting) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied("yes");
    } catch {
      // The browser would not copy (no permission, or no clipboard): the code and the field are still there.
      setCopied("failed");
    }
  };

  const connectPasted = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const uri = pasted.trim();
    if (uri === "" || pasting) return;
    // One connection at a time: the code's wait ends.
    scanning.current?.abort();
    const controller = new AbortController();
    pastingRef.current = controller;
    setPasting(true);
    connect.bunker(uri, controller.signal).catch(() => {
      if (!controller.signal.aborted) onFailed();
    });
  };

  return (
    <>
      <p ref={said} tabIndex={-1} className={`m-0 text-center text-body font-semibold leading-[1.45] outline-none ${look.text}`}>
        {copy.signin.scan}
      </p>
      {/* The light square behind the code, which draws its own quiet zone (QUIET_ZONE). */}
      <div className={`mx-auto flex size-[232px] shrink-0 items-center justify-center overflow-hidden rounded-tile bg-ground text-ink ${look.code}`}>
        {link !== undefined && !pasting && <QrCode text={link} label={copy.signin.qrLabel} />}
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="flex flex-wrap justify-center gap-2">
          {handheld && link !== undefined && !pasting && (
            <a href={link} className={`${SMALL} ${look.primary} no-underline`}>
              {copy.signin.openApp}
            </a>
          )}
          <button
            type="button"
            onClick={() => void copyLink()}
            aria-disabled={link === undefined || pasting ? true : undefined}
            className={`${SMALL} ${look.secondary} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            {copy.signin.copyLink}
          </button>
        </div>
        <p role="status" className={`m-0 min-h-[1.45em] text-center text-caption leading-[1.45] ${look.note}`}>
          {copied === "yes" ? copy.signin.copied : copied === "failed" ? copy.signin.notCopied : ""}
        </p>
      </div>
      <form onSubmit={connectPasted} className="flex flex-col gap-2">
        <label htmlFor={fieldId} className={`text-secondary font-semibold ${look.text}`}>
          {copy.signin.paste}
        </label>
        <div className="flex gap-2">
          <input
            id={fieldId}
            type="text"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`h-11 min-w-0 flex-1 rounded-button px-3 font-text text-body ${look.field}`}
          />
          <button
            type="submit"
            aria-disabled={pasting ? true : undefined}
            className={`${SMALL} ${look.secondary} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            {copy.signin.connect}
          </button>
        </div>
      </form>
      <p role="status" className={`m-0 text-center text-caption leading-[1.45] ${look.note}`}>
        {pasting ? copy.signin.connecting : ""}
      </p>
      <CancelButton look={look} onCancel={onCancel} />
    </>
  );
}

/** It did not connect: said as an alert, with Try again, which has the focus, and Cancel, which gives Continue back. */
function Failed({ look, onRetry, onCancel }: { look: Look; onRetry(): void; onCancel(): void }): JSX.Element {
  const retry = useRef<HTMLButtonElement>(null);
  useFocusOnMount(retry);
  return (
    <>
      <p role="alert" className={`m-0 text-center text-body font-semibold leading-[1.45] ${look.text}`}>
        {copy.signin.failed}
      </p>
      <button ref={retry} type="button" onClick={onRetry} className={`${BIG} ${look.primary}`}>
        {copy.signin.tryAgain}
      </button>
      <CancelButton look={look} onCancel={onCancel} />
    </>
  );
}

/** Where the phone's way is: waiting on the phone app (each try its own), or having failed. */
type Step = { at: "waiting"; attempt: number } | { at: "failed" };

/**
 * The phone's way of signing in, in place of Continue: the code, the link and the field, from when it
 * is drawn. `onCancel` gives Continue back. Once the person is signed in, the sign-in page takes them
 * on (./SignInPage.tsx).
 */
export function PhoneWay({ tone, onCancel }: { tone: Tone; onCancel(): void }): JSX.Element {
  const look = LOOK[tone];
  const [step, setStep] = useState<Step>({ at: "waiting", attempt: 0 });
  const attempts = useRef(0);
  const retry = () => {
    attempts.current += 1;
    setStep({ at: "waiting", attempt: attempts.current });
  };

  return (
    <div className="flex flex-col gap-3">
      {step.at === "waiting" ? (
        <PhonePanel key={step.attempt} look={look} onFailed={() => setStep({ at: "failed" })} onCancel={onCancel} />
      ) : (
        <Failed look={look} onRetry={retry} onCancel={onCancel} />
      )}
    </div>
  );
}
