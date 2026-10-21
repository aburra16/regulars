import { type JSX, useId, useLayoutEffect, useMemo, useRef } from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { heldKeyPressesNothing } from "../circle/Personalize.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { distanceKm } from "../places/distance.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { usePlaces } from "../places/store.tsx";
import { useIndexes } from "../places/useIndexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { LoadFailed, primaryButton, quietLine, wordButton } from "../ui/Banner.tsx";
import { NotListedIcon } from "../ui/icons.tsx";
import { PlaceCard } from "../ui/PlaceCard.tsx";
import { SavedSoon, SignedOutPrompt } from "../you/SignedOutPrompt.tsx";
import { NOT_MADE } from "./SaveButton.tsx";
import { type SavedList, useSaved, useSavedList } from "./SavedProvider.tsx";

/*
 * The Saved page: the places the person signed in has saved, as Explore draws them
 * (src/explore/Entries.tsx), newest saved first, one under another on a phone and in a grid on a
 * desktop, under the line that says anyone can see them. Signed out, the prompt to sign in, as before.
 *
 * It draws from the session's own list (`useSavedList`, ./SavedProvider.tsx), and changes it only on
 * a press of Remove from list, or of its Try again, which go down the same path as a press of Saved: a
 * saved place that came off the map has no card, as its name went with it, and says so, with the way
 * to take it out. Such a place is said to be gone only when the places on screen are the latest list,
 * whole: while they are this device's copy, or a load that stopped short, the latest may have it, and
 * it is left out rather than called gone (as `NotListedOrLoading`, src/ui/NotListed.tsx, reasons). So
 * are the entries the app does not know as places (another app's, another curator's): they stay in
 * the list, and are not shown. When every place of the list is left out so, the page shows no empty
 * list: it is finding the places while the latest may still come, and says they could not be loaded,
 * with Try again, once it could not be.
 *
 * While saving is closed (`config.features.saved`), the page is as it was before it opened.
 */

/** A line of the page's in place of its places: while they come, and when there are none. */
const pageLine = "m-0 text-body leading-[1.5] text-ink-soft";

/** The page's line while what it shows is still coming: the person's list, or the places it holds. */
function FindingPlaces(): JSX.Element {
  return (
    <p role="status" className={pageLine}>
      {copy.load.loading}
    </p>
  );
}

/** One of the page's entries, in the order of the list: a place on the map, or the address of one that came off it. */
type Shown = { place: PlaceDistance } | { gone: string };

/**
 * A saved place that came off the map (the design): no name, as it went with the place, but that it
 * is no longer listed and why, and Remove from list, which takes it out of the person's list. While
 * that is made it says Saving…, and a press does nothing; it is one button throughout, so the focus
 * stays on it. What the press left to say (that it was not made, with Try again, which makes it again)
 * is the session's for the place (`useSaved`), as a Save button's is, in a polite status under it.
 * `removing` is told before each press that may take it out.
 */
function NoLongerListed({ address, removing }: { address: string; removing(address: string): void }): JSX.Element {
  const of = useSaved({ address });
  const { remove } = useSavedList();
  const button = useRef<HTMLButtonElement>(null);
  const lineId = useId();
  const saving = of.state === "saving";
  const line = of.line === undefined || of.line === "first-save" ? undefined : NOT_MADE[of.line];

  const onPress = () => {
    // Off while the change is made.
    if (saving) return;
    removing(address);
    remove(address);
  };

  const tryAgain = () => {
    // Try again goes as it is pressed: the focus goes to the button first, which stays.
    button.current?.focus({ preventScroll: true });
    removing(address);
    of.retry();
  };

  return (
    <div className="flex gap-3.5 rounded-card border-token border-line bg-surface p-3.5">
      <span
        aria-hidden="true"
        className="flex size-13 shrink-0 items-center justify-center rounded-tile border-token border-dashed border-line-dashed text-muted"
      >
        <NotListedIcon size={24} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 text-secondary font-bold">{copy.place.noLongerListed}</p>
        <p className="m-0 text-secondary leading-[1.45] text-muted">{copy.place.noLongerListedDetail}</p>
        <button
          ref={button}
          type="button"
          // Off, not gone, while the change is made: the focus stays on it.
          aria-disabled={saving ? true : undefined}
          onClick={onPress}
          onKeyDown={heldKeyPressesNothing}
          className={`inline-flex min-h-touch items-center self-start border-0 bg-transparent p-0 font-text text-secondary font-bold ${
            saving ? "cursor-default text-muted" : "cursor-pointer text-accent"
          }`}
        >
          {saving ? copy.saved.saving : copy.saved.removeFromList}
        </button>
        <div onKeyDown={heldKeyPressesNothing} className="flex min-w-0 flex-wrap items-center gap-x-4">
          {/* Always there while the entry is, so a screen reader hears the line as it comes. Empty, it takes no room. */}
          <div role="status" className="min-w-0">
            {line !== undefined && (
              <p id={lineId} className={quietLine}>
                {line}
              </p>
            )}
          </div>
          {line !== undefined && (
            <button type="button" aria-describedby={lineId} onClick={tryAgain} className={wordButton}>
              {copy.saved.tryAgain}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The saved places at `addresses`, newest saved first: each on the map as Explore's card, with how
 * far it is from where the person is and its score in the view on screen; each that came off the map
 * as `NoLongerListed`, when the places on screen are the latest list, whole. They wait for the places,
 * and for where the person is to be known, as Explore does; the places that could not be loaded are
 * said so, with Try again. When every one of `addresses` is left out (none is among the places on
 * screen, which are not the latest, whole), there is no empty list: the page is finding the places
 * while the latest may still come, and says they could not be loaded, with Try again, once it could
 * not be (as `NotListedOrLoading` reasons). `labelledBy` names the list. `removing` is told of each
 * entry pressed to be taken out of the list.
 */
function SavedPlaces({
  addresses,
  labelledBy,
  removing,
}: {
  addresses: readonly string[];
  labelledBy: string;
  removing(address: string): void;
}): JSX.Element {
  const indexes = useIndexes();
  const { source, complete, status, error, retry } = usePlaces();
  const here = useHere();
  const now = useNow();
  const locale = useLocale();
  // The places the person may be told have gone: those of the latest list, loaded to its end.
  const whole = source === "network" && complete;

  const rows = useMemo<PlaceDistance[]>(() => {
    if (indexes === undefined) return [];
    return addresses.flatMap((address) => {
      const place = indexes.byAddress.get(address);
      return place === undefined ? [] : [{ place, km: distanceKm(here.lat, here.lon, place.lat, place.lon) }];
    });
  }, [indexes, addresses, here.lat, here.lon]);
  // The scores of the whole list, asked for in one go. The list stays newest saved first.
  const { scores } = useListScores(rows);
  const shown = useMemo<Shown[]>(() => {
    const onMap = new Map(rows.map((row) => [row.place.address, row]));
    return addresses.flatMap((address): Shown[] => {
      const row = onMap.get(address);
      if (row !== undefined) return [{ place: row }];
      return whole && indexes !== undefined ? [{ gone: address }] : [];
    });
  }, [rows, addresses, whole, indexes]);

  if (indexes === undefined || here.settling === true) {
    return status === "error" ? <LoadFailed retry={retry} /> : <FindingPlaces />;
  }
  // Every place of the list left out: the places on screen are this device's copy, or a load that
  // stopped short, and none of the list is among them. No empty list: the latest may still come, or
  // it could not be loaded.
  if (shown.length === 0) {
    return source === "cache" && error === undefined ? <FindingPlaces /> : <LoadFailed retry={retry} />;
  }

  return (
    <ul
      role="list"
      aria-labelledby={labelledBy}
      className="m-0 flex list-none flex-col gap-3 p-0 wide:grid wide:grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]"
    >
      {shown.map((entry) => {
        if ("gone" in entry) {
          return (
            <li key={entry.gone} className="grid">
              <NoLongerListed address={entry.gone} removing={removing} />
            </li>
          );
        }
        const { place, km } = entry.place;
        const score = scores.of(place.address);
        return (
          <li key={place.address} className="grid">
            <PlaceCard
              place={place}
              km={km}
              // As Explore's cards: a place only others have rated is dashed in a list where some place has a score.
              variant={scores.anyScored && score.kind === "unscored" ? "unrated-dashed" : "normal"}
              score={score}
              locale={locale}
              now={now}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Saved for the person signed in, or about to be (a session this tab kept being restored): the
 * heading, the line that their saved places are public, and under them their places; or, while the
 * list is read, that it is; when it could not be read, that it couldn't, with Try again, which reads
 * it again; with none saved, that there are none. The region under the line keeps the focus when
 * what had it goes: Try again, and an entry taken out of the list, the last of them too, when the
 * list goes with it.
 */
function Yours({ list }: { list: SavedList }): JSX.Element {
  useDocumentTitle(copy.titles.saved);
  const headingId = useId();
  const region = useRef<HTMLDivElement>(null);

  // The address an entry was pressed to take out of the list, until it is out.
  const removing = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const address = removing.current;
    if (address === undefined || list.addresses.includes(address)) return;
    removing.current = undefined;
    // Its entry went with the button that had the focus, and the list with it when it was the last:
    // the focus goes to the region, which is here whatever it now holds.
    if (document.activeElement === null || document.activeElement === document.body) region.current?.focus({ preventScroll: true });
  }, [list.addresses]);

  let body: JSX.Element;
  if (list.status === "failed") {
    body = (
      <div className="flex flex-col items-start gap-5">
        <p role="alert" className={pageLine}>
          {copy.saved.failed}
        </p>
        <button
          type="button"
          onClick={() => {
            region.current?.focus({ preventScroll: true });
            list.retry();
          }}
          className={primaryButton}
        >
          {copy.saved.tryAgain}
        </button>
      </div>
    );
  } else if (list.status !== "ready") {
    body = <FindingPlaces />;
  } else if (list.addresses.length === 0) {
    body = <p className={pageLine}>{copy.saved.empty}</p>;
  } else {
    body = (
      <SavedPlaces
        addresses={list.addresses}
        labelledBy={headingId}
        removing={(address) => {
          removing.current = address;
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-gutter-phone pt-[22px] pb-8 wide:px-gutter-desktop wide:pt-9 wide:pb-14">
      <h1
        id={headingId}
        tabIndex={-1}
        className="m-0 font-display text-display-phone font-extrabold tracking-display outline-none wide:text-display-desktop"
      >
        {copy.pages.saved}
      </h1>
      <p className="m-0 mt-1.5 text-secondary leading-[1.45] text-muted">{copy.saved.public}</p>
      <div ref={region} tabIndex={-1} className="mt-[18px] flex flex-col outline-none">
        {body}
      </div>
    </div>
  );
}

/**
 * Saved. Before sign in, the prompt to sign in. After, the person's saved places (`Yours`). While
 * saving is closed, the page as it was before it opened: the prompt to sign in, and after sign in,
 * that saving opens soon.
 */
export function SavedPage(): JSX.Element {
  const { account, restoring } = useAccount();
  const list = useSavedList();
  if (!config.features.saved) return account === undefined && !restoring ? <SignedOutPrompt page="saved" /> : <SavedSoon />;
  return list.status === "signed-out" ? <SignedOutPrompt page="saved" /> : <Yours list={list} />;
}
