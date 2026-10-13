import { type JSX, type KeyboardEvent, type MouseEvent, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { heldKeyPressesNothing } from "../circle/Personalize.tsx";
import { copy } from "../copy/en.ts";
import { formatDayAndTime } from "../locale.ts";
import { writtenOn } from "../reviews/when.ts";
import { useNames } from "../score/useScore.ts";
import { useLocale } from "../shell/useLocale.ts";
import { quietLine, wordButton } from "../ui/Banner.tsx";
import { Named } from "../ui/Named.tsx";
import { type PutBackEnd, type PutBackOf, usePutBack } from "./keptStore.ts";
import type { Kept } from "./kept.ts";

/*
 * The copies of the person's own follow list that were kept in this browser, on their own page: one
 * before each change they made here (./kept.ts), each saying what it was kept before and when, with
 * the way to put it back. A follow list is one record that saving replaces everywhere, so a change
 * built on the wrong list loses follows for good: a copy is what they can be had back from.
 *
 * Putting a copy back replaces the person's whole list, which no other control in the app does, so
 * it asks first, in place: Put back shows the asking and changes nothing, and only a press of Put
 * it back in the asking writes (`Asking`, the one place that asks the session's store for it;
 * tests/followGuard.test.ts holds the code to that). The write itself is `putBackList`'s
 * (./change.ts), start to end, by the steps of any change to the list, and the list as it is now is
 * kept first, so that putting back can itself be put back.
 *
 * Nothing here reads the device's storage, a relay or a signer: it draws what the session holds
 * (`usePutBack`, ./keptStore.ts), which reads the copies for the person signed in, and for
 * nobody while Follow is not open. A row never says how many people a copy holds, nor anything else
 * with a number in it about anyone (decision 19), and names nobody by a code.
 */

/** A copy among the others: the list it holds, and when it was kept. The same copy read again from the storage is the same one. */
const keyOf = (kept: Kept): string => `${kept.list.id}:${kept.at}`;

/** The line for each way a putting back ends. */
const ENDED: Record<PutBackEnd, string> = {
  done: copy.follow.putBackDone,
  unchanged: copy.follow.putBackAlready,
  "not-loaded": copy.follow.notLoaded,
  "not-kept": copy.follow.notKept,
  "not-approved": copy.follow.notApproved,
  "not-saved": copy.follow.notSaved,
  unconfirmed: copy.follow.unconfirmed,
};

/** The ways a putting back ends with nothing changed, and may be tried again: as a follow's Try again has it. */
const MAY_TRY_AGAIN: ReadonlySet<PutBackEnd> = new Set(["not-loaded", "not-kept", "not-approved", "not-saved"]);

/** A button of the asking, 44 px tall, in the chip's shape; off, not gone, while a copy is being put back. */
const askingButton = "h-11 shrink-0 cursor-pointer rounded-chip px-4 font-text text-secondary font-bold aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/**
 * The asking, in place of a row's Put back: what putting the copy back does and what it loses, with
 * Keep my list as it is, which has the focus as the asking opens, and Put it back.
 *
 * `onPutItBack` is the one place in the app that asks for a list to be put back, and it is the click
 * of Put it back and nothing else's: no effect, no timer and no key but a press on that button
 * reaches it. The second click of a double click is no yes, so a double click on Put back, which
 * opened the asking, does not also answer it; nor is a press while a copy is being put back.
 * Meanwhile the button says Saving…, and both are off, not gone: the focus stays where it was.
 *
 * Escape and Keep my list as it is take the asking away (`onKeep`), and change nothing; not while
 * the copy is being put back. When the asking goes with the focus in it, however it goes (closed by
 * the person, or the copy put back, or not), the focus goes `home`, to the row's Put back, which is
 * back in its place by then: a control the person can see the focus on, beside what the row then
 * says came of it. A focus the person has put elsewhere meanwhile is left where it is. It is looked
 * at once the asking is out of the page, so that React's development run of an effect twice moves
 * nothing.
 */
function Asking({
  kept,
  of,
  saving,
  opened,
  home,
  onKeep,
  onAnswered,
}: {
  kept: Kept;
  of: PutBackOf;
  /** Whether this copy is being put back. */
  saving: boolean;
  /** Whether a press opened it, here and now: then Keep my list as it is takes the focus. Not when it is drawn for a putting back that was under way already. */
  opened: boolean;
  /** The row's Put back: where the focus goes when the asking goes with the focus in it. */
  home: RefObject<HTMLElement | null>;
  onKeep(): void;
  /** Told as Put it back is pressed, before the list is asked for: the asking is the session's to show from then. */
  onAnswered(): void;
}): JSX.Element {
  const self = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  useLayoutEffect(() => {
    const node = self.current;
    return () => {
      if (node === null || !node.contains(document.activeElement)) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        const to = home.current;
        if (!node.isConnected && (now === null || now === document.body) && to?.isConnected === true) to.focus();
      });
    };
  }, [home]);

  // The answer that changes nothing has the focus first: a second quick press keeps the list.
  useEffect(() => {
    if (opened) keep.current?.focus();
  }, [opened]);

  const onPutItBack = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1 || saving) return;
    onAnswered();
    of.putBack(kept);
  };
  const onKeepPressed = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1 || saving) return;
    onKeep();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || saving) return;
    event.preventDefault();
    onKeep();
  };

  return (
    <div ref={self} role="group" aria-labelledby={questionId} onKeyDown={onKeyDown} className="flex flex-col gap-3 rounded-card bg-surface p-4">
      <p id={questionId} className="m-0 max-w-measure text-body leading-[1.45] text-ink">
        {copy.follow.putBackQuestion}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={keep}
          type="button"
          aria-disabled={saving ? true : undefined}
          onClick={onKeepPressed}
          className={`${askingButton} border-token border-line-strong bg-ground text-ink`}
        >
          {copy.follow.keepAsItIs}
        </button>
        <button type="button" aria-disabled={saving ? true : undefined} onClick={onPutItBack} className={`${askingButton} border-0 bg-accent-solid text-on-accent`}>
          {saving ? copy.follow.saving : copy.follow.putItBack}
        </button>
      </div>
    </div>
  );
}

/** What a row says a putting back of its copy came to: seen beside the copy it is about, and a little stronger than the row's date. */
const endedLine = "m-0 text-secondary leading-[1.4] font-semibold text-ink";

/**
 * A copy's row: what it was kept before, when, and Put back, or the asking in its place; and under
 * them, politely, what the last putting back of this copy came to (`ended`), with Try again for one
 * that changed nothing. `name` is the name of the person the change was to, as the app knows it;
 * never a code.
 *
 * What a putting back came to is said in the row of the copy it was of, where the person pressed
 * and where the focus is, in a polite status of the row's own that is there for as long as the row
 * is, so that a screen reader hears the line as it comes. Empty, it takes no room. Try again opens
 * the asking again, as Put back does, and changes nothing.
 *
 * A row goes when its copy is no longer kept: the newest ten are, and a change made in another tab
 * may have pushed this one out. When it goes with the focus in it (on its Put back, or in its
 * asking), the focus would drop to the page, so it goes `home`, to the section's heading. Looked at
 * once the row is out of the page, as the asking does, and a focus the person has put elsewhere is
 * left where it is.
 */
function Row({
  kept,
  name,
  when,
  asked,
  off,
  ended,
  home,
  onAsk,
  children,
}: {
  kept: Kept;
  name: string;
  when: string;
  /** Whether the asking is in Put back's place (`children`). */
  asked: boolean;
  /** Whether Put back is off: another copy is being put back. */
  off: boolean;
  /** How the last putting back of this copy ended, while that is still to be said; null when there is nothing to say. */
  ended: PutBackEnd | null;
  /** The section's heading: where the focus goes when the row goes with the focus in it. */
  home: RefObject<HTMLElement | null>;
  onAsk(): void;
  /** The asking, given the row's Put back: where the focus goes back to when the asking goes. */
  children(word: RefObject<HTMLButtonElement | null>): JSX.Element;
}): JSX.Element {
  const self = useRef<HTMLLIElement>(null);
  const word = useRef<HTMLButtonElement>(null);
  const beforeId = useId();
  const whenId = useId();
  const endedId = useId();
  const why = kept.for;

  useLayoutEffect(() => {
    const node = self.current;
    return () => {
      if (node === null || !node.contains(document.activeElement)) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        const to = home.current;
        if (!node.isConnected && (now === null || now === document.body) && to?.isConnected === true) to.focus({ preventScroll: true });
      });
    };
  }, [home]);

  let before: JSX.Element | string;
  if (why.did === "follow") before = <Named line={copy.follow.keptBeforeFollow} name={name} />;
  else if (why.did === "unfollow") before = <Named line={copy.follow.keptBeforeUnfollow} name={name} />;
  else before = why.did === "undo" ? copy.follow.keptBeforeUndo : copy.follow.keptBeforePutBack;

  return (
    <li ref={self} className="flex flex-col border-t-token border-line py-2">
      {/* Put back stays at the end of the row, level with its words, however long a name makes them: they wrap beside it. */}
      <div className="flex items-center justify-between gap-x-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
          <p id={beforeId} className="m-0 text-body wrap-break-word text-ink">
            {before}
          </p>
          <p id={whenId} className={quietLine}>
            <time dateTime={writtenOn(kept.at)?.toISOString()}>{when}</time>
          </p>
        </div>
        {!asked && (
          <button
            ref={word}
            type="button"
            aria-describedby={`${beforeId} ${whenId}`}
            aria-disabled={off ? true : undefined}
            onClick={() => {
              if (!off) onAsk();
            }}
            className={`${wordButton} shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            {copy.follow.putBack}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4">
        <div role="status" className="flex min-w-0 flex-col">
          {ended !== null && (
            <p id={endedId} className={endedLine}>
              {ENDED[ended]}
            </p>
          )}
        </div>
        {ended !== null && MAY_TRY_AGAIN.has(ended) && (
          <button type="button" aria-describedby={endedId} onClick={onAsk} className={wordButton}>
            {copy.follow.tryAgain}
          </button>
        )}
      </div>
      {asked && <div className="pt-1 pb-2">{children(word)}</div>}
    </li>
  );
}

/**
 * The copies kept of the follow list of the person signed in, whose key is `pubkey`, on their own
 * page: nothing at all until there is one. Under the heading, what the copies are; then the copies,
 * newest first, each in a row that says what the last putting back of it came to (`Row`).
 *
 * One row asks at a time. Put back opens the asking in its row, and Try again opens it again for
 * the copy that was not put back: neither changes anything, as only the asking's own Put it back
 * does (`Asking`). An asking whose copy is no longer listed is let go of with its row: it hides no
 * line that comes after, and is not there again if that copy is. A copy that is being put back
 * shows its asking wherever the page is drawn, with Saving…, and every other Put back is off until
 * it has ended. Once it has, the copies are as the session then holds them: the list that was
 * replaced is the newest of them.
 *
 * What a putting back came to is said in the row of its copy (`Row`). When that copy has no row by
 * then (it is no longer among the ten kept: a change in another tab pushed it out), it is said at
 * the section's head, in a polite status of the section's own that is there for as long as the
 * section is; and the focus, which went with the row, is on the section's heading. There is nothing
 * to try again there: the copy is no longer held.
 *
 * A key held down presses nothing a second time (`heldKeyPressesNothing`): neither a row's Put back,
 * as the focus comes back to it, nor an answer of the asking.
 */
export function KeptCopies({ pubkey }: { pubkey: string }): JSX.Element | null {
  const of = usePutBack(pubkey);
  const locale = useLocale();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  /** The copy the asking is for, by a press here; null when none was asked about, and once Put it back was pressed. */
  const [asking, setAsking] = useState<string | null>(null);
  /** How a putting back ended, once the person has moved on from it: by opening an asking. Not said again. */
  const [heard, setHeard] = useState<PutBackOf["ended"]>(null);

  const { copies, saving, ended } = of;
  // Each copy once: the same list kept in the same second is one copy, should the storage hold it twice.
  const listed = useMemo(() => copies.filter((kept, place) => copies.findIndex((each) => keyOf(each) === keyOf(kept)) === place), [copies]);
  const whom = useMemo(() => [...new Set(listed.flatMap((kept) => ("who" in kept.for ? [kept.for.who] : [])))], [listed]);
  const names = useNames(whom);

  // An asking is for a row, and goes with it: once its copy is no longer listed, nothing is asked
  // about, and the row asks nothing by itself should that copy be listed again.
  if (asking !== null && !listed.some((kept) => keyOf(kept) === asking)) setAsking(null);

  if (listed.length === 0) return null;

  const savingKey = saving === null ? null : keyOf(saving);
  /** How the last putting back ended, while it is to be said: in the row of the copy it was of, until the person opens an asking. */
  const said = ended !== null && ended !== heard && asking === null && saving === null ? ended : null;
  const saidOf = said === null ? null : keyOf(said.copy);
  /** Whether the copy it was of has no row to say it in. */
  const saidAtHead = saidOf !== null && !listed.some((kept) => keyOf(kept) === saidOf);

  /** Opens the asking for `kept`, and changes nothing. What the last putting back came to has been heard by then. */
  const ask = (kept: Kept) => {
    setHeard(ended);
    setAsking(keyOf(kept));
  };

  return (
    <section aria-labelledby={headingId} onKeyDown={heldKeyPressesNothing} className="flex flex-col gap-3">
      {/* No ring: it holds the focus only when a row has gone with the focus in it. */}
      <h2 ref={heading} id={headingId} tabIndex={-1} className="m-0 font-display text-h2 font-bold outline-none">
        {copy.follow.keptHeading}
      </h2>
      <div className="flex flex-col">
        <p className={`${quietLine} max-w-measure`}>{copy.follow.keptAbout}</p>
        {/* Always there while the section is, so a screen reader hears the line as it comes. Empty, it takes no room. */}
        <div role="status" className="flex flex-col">
          {said !== null && saidAtHead && <p className={`${endedLine} pt-3`}>{ENDED[said.how]}</p>}
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col border-b-token border-line p-0">
        {listed.map((kept) => {
          const key = keyOf(kept);
          const isSaving = key === savingKey;
          const name = "who" in kept.for ? names.get(kept.for.who) : undefined;
          return (
            <Row
              key={key}
              kept={kept}
              // Whoever the app has no name for is someone, in the words of the line: never "Someone" in its middle, and never a code.
              name={name === undefined || name === copy.reviews.someone ? copy.follow.keptSomeone : name}
              // When it was kept, with the time of day, as there may be several in a day.
              when={formatDayAndTime(kept.at, locale)}
              asked={isSaving || (saving === null && key === asking)}
              off={saving !== null}
              ended={said !== null && key === saidOf ? said.how : null}
              home={heading}
              onAsk={() => ask(kept)}
            >
              {(word) => (
                <Asking
                  kept={kept}
                  of={of}
                  saving={isSaving}
                  opened={!isSaving && key === asking}
                  home={word}
                  onKeep={() => setAsking(null)}
                  onAnswered={() => setAsking(null)}
                />
              )}
            </Row>
          );
        })}
      </ul>
    </section>
  );
}
