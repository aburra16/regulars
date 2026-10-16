import { type JSX, useState } from "react";

import { copy } from "../copy/en.ts";
import { isHttpsUrl } from "../reviews/review.ts";
import { NewTabHint, Unseen } from "./NewTab.tsx";

/*
 * Photos: a review's, as thumbnails or as one link, and the strip under a place's name. Which are
 * drawn is the page's to say: a photo is drawn only from a review by someone who counts in the view on
 * screen, the person's own, or the place's own image. Anywhere else a review's photos are one link, and
 * nothing is asked for until it is tapped.
 *
 * Only `https:` addresses are drawn, linked or counted (`isHttpsUrl`), whatever the pieces are given.
 * Each photo is asked for lazily, as it nears the screen, with no referrer, so the server it is on
 * learns nothing of which page it is on. Each opens in a new tab, which cannot reach back to this one.
 * Its frame is a fixed square that it covers, so nothing moves as it loads, and the frame's ground shows
 * until then; one that fails to load takes its tile away. Nothing beside a photo says anything of a
 * person but their name.
 */

/** The most thumbnails a review shows: the rest are counted in a tile after them, which opens the next. */
export const TILES_MAX = 4;

/**
 * A review's tile: a square as wide as the item it is in (`REVIEW_ITEM`). Never a fixed size: a
 * review's tiles are one row that never wraps, and a phone's row may be narrower than five of them.
 */
const REVIEW_FRAME = "aspect-square w-full";

/**
 * Each tile's place in a review's row: an even share of it, at most 72 px on a phone and 80 on a
 * desktop, and never less than a touch target (44 px). Four thumbnails and the count fit one row of a
 * phone 375 px wide, inside a card on Trending too.
 */
const REVIEW_ITEM = "min-w-touch max-w-[72px] flex-1 wide:max-w-20";

/** A tile of the strip under a place's name, larger than a review's. */
const STRIP_FRAME = "size-[120px]";

/** A tile's square, whatever is in it: rounded, the ground showing while its photo loads. */
const FRAME = "shrink-0 overflow-hidden rounded-[10px] bg-surface";

/** What makes a link open a new tab that cannot reach back to this one, and is told nothing of where it came from. */
const OUT = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * Those of `photos` that may be shown: the `https:` ones (`isHttpsUrl`), less any that has failed to
 * load here. `fail` notes one that has, and this draws again without it.
 */
function useShown(photos: readonly string[]): [shown: string[], fail: (photo: string) => void] {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const shown = photos.filter((photo) => isHttpsUrl(photo) && !failed.has(photo));
  return [shown, (photo) => setFailed((before) => new Set(before).add(photo))];
}

/** One photo in its `frame`, filling it, a link that opens it. `alt` says whose photo of what. */
function Tile({
  photo,
  alt,
  frame,
  muted = false,
  onFail,
}: {
  photo: string;
  alt: string;
  frame: string;
  muted?: boolean;
  onFail: () => void;
}): JSX.Element {
  return (
    <a href={photo} {...OUT} className={`block ${FRAME} ${frame}`}>
      <img
        src={photo}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={onFail}
        className={`size-full object-cover ${muted ? "opacity-60" : ""}`}
      />
      <NewTabHint />
    </a>
  );
}

/**
 * A review's photos (`photos`), by the reviewer named `reviewer`. `drawn`, up to `TILES_MAX`
 * thumbnails in one row, and the rest counted in a tile after them ("+2") that opens the first of the
 * rest; each named apart from the others for a screen reader ("Photo 1 of 6 from a review by Maya",
 * "2 more photos from a review by Maya"). Not `drawn`, one link to the first, "Photo" or "2 photos",
 * and no image. Nothing when there is none to show. `muted` draws them in the folded box's dimmed look.
 */
export function ReviewPhotos({
  photos,
  drawn,
  reviewer,
  muted = false,
}: {
  photos: readonly string[];
  drawn: boolean;
  reviewer: string;
  muted?: boolean;
}): JSX.Element | null {
  const [shown, fail] = useShown(photos);
  const first = shown[0];
  if (first === undefined) return null;
  const ink = muted ? "text-muted" : "text-ink";
  if (!drawn) {
    return (
      <a
        href={first}
        {...OUT}
        className={`inline-flex min-h-touch min-w-touch items-center self-start text-secondary underline ${ink} ${muted ? "" : "hover:text-accent"}`}
      >
        {copy.photos.link(shown.length)}
        <NewTabHint />
      </a>
    );
  }
  const next = shown[TILES_MAX];
  const rest = shown.length - TILES_MAX;
  return (
    <ul role="list" className="m-0 flex list-none flex-nowrap gap-2 p-0">
      {shown.slice(0, TILES_MAX).map((photo, i) => (
        <li key={photo} className={REVIEW_ITEM}>
          <Tile
            photo={photo}
            alt={copy.photos.ofReview(i + 1, shown.length, reviewer)}
            frame={REVIEW_FRAME}
            muted={muted}
            onFail={() => fail(photo)}
          />
        </li>
      ))}
      {next !== undefined && (
        <li className={REVIEW_ITEM}>
          <a
            href={next}
            {...OUT}
            className={`flex items-center justify-center ${FRAME} ${REVIEW_FRAME} text-secondary font-bold no-underline hover:underline ${ink}`}
          >
            {/* "+2" to the eye; what it is, and whose, to a screen reader. */}
            <span aria-hidden="true">{copy.photos.more(rest)}</span>
            <Unseen text={copy.photos.moreOfReview(rest, reviewer)} />
            <NewTabHint />
          </a>
        </li>
      )}
    </ul>
  );
}

/**
 * The strip of a place's photos: `photos` (`stripPhotos`, src/place/summary.ts), each a tile that
 * names the place (`placeName`) and which of the strip's photos it is ("Photo 3 of 9 of Jacafé"). A
 * row that scrolls sideways on a phone, each tile coming to rest at its start, and a row that wraps on
 * a desktop. Nothing, not even its name, when there is none to show.
 */
export function PhotoStrip({ photos, placeName }: { photos: readonly string[]; placeName: string }): JSX.Element | null {
  const [shown, fail] = useShown(photos);
  if (shown.length === 0) return null;
  return (
    // Its 4 px of padding keep the focus ring of the tile at either end inside what the row shows, and
    // its margin as much the other way keeps the tiles where they would be without it.
    <ul
      role="list"
      aria-label={copy.photos.strip(placeName)}
      className="-m-1 flex list-none snap-x snap-mandatory scroll-px-1 gap-2 overflow-x-auto p-1 wide:snap-none wide:flex-wrap wide:overflow-visible"
    >
      {shown.map((photo, i) => (
        <li key={photo} className="snap-start">
          <Tile photo={photo} alt={copy.photos.ofPlace(i + 1, shown.length, placeName)} frame={STRIP_FRAME} onFail={() => fail(photo)} />
        </li>
      ))}
    </ul>
  );
}
