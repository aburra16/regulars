import { type JSX, type ReactNode, useMemo } from "react";

import { copy } from "../copy/en.ts";
import { openState, weekTable } from "../places/hours.ts";
import type { Place } from "../places/place.ts";
import type { Paid } from "../reviews/review.ts";
import { Address } from "../ui/address.tsx";
import { actionsOf } from "./Actions.tsx";
import type { priceOf } from "./summary.ts";

/**
 * The address as one line: the street address, then the town and the postcode where it does not
 * already name them (the importer writes most addresses whole: "138 Rua dos Ferreiros Funchal
 * 9000-082"). Nothing when the place has none of them. The text is as written: the page draws it
 * with <Address>, which keeps the postcode whole on its line.
 */
export function addressOf(place: Pick<Place, "street" | "locality" | "postalCode">): string | undefined {
  let line = place.street?.trim() ?? "";
  for (const part of [place.locality, place.postalCode]) {
    const text = part?.trim();
    if (text === undefined || text === "" || line.toLowerCase().includes(text.toLowerCase())) continue;
    line = line === "" ? text : `${line} ${text}`;
  }
  return line === "" ? undefined : line;
}

/** A fact: its label at 74 px, and what it says beside it (the design). A fact with nothing to say is not drawn. */
function Fact({ label, children, muted = false, centred = false }: { label: string; children: ReactNode; muted?: boolean; centred?: boolean }): JSX.Element {
  return (
    <div className={`flex gap-3 ${centred ? "items-center" : ""}`}>
      <dt className="w-[74px] flex-none text-muted">{label}</dt>
      <dd className={`m-0 min-w-0 flex-1 wrap-break-word ${muted ? "text-muted" : ""}`}>{children}</dd>
    </div>
  );
}

/** The week's hours, Monday first: each day and its openings, or Closed. */
function WeekHours({ week }: { week: NonNullable<ReturnType<typeof weekTable>> }): JSX.Element {
  return (
    <table className="border-collapse text-left">
      <tbody>
        {week.map(({ day, ranges }) => (
          <tr key={day} className="align-top">
            <th scope="row" className="pr-3 pb-1 font-normal whitespace-nowrap">
              {day}
            </th>
            <td className="pb-1">{ranges.length === 0 ? copy.hours.closed : ranges.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What is known about a place (the design): its address, its hours, its phone and, when it takes
 * bitcoin, a payment row with the chip, which says how it takes it ("Bitcoin: Lightning"). Hours are
 * always there, "Not listed" in grey when there are none; any other fact the place lacks is left out,
 * never drawn empty. Hours the app can read are the week ahead as a table; hours it cannot are as
 * written. Everything here came from a relay, so every value wraps rather than push the page wider.
 *
 * Two facts come from the reviews inside the view on screen, which the page sums (./summary.ts): under
 * the hours, `price`, the price most of them give ("$$", then "from 3 reviews" in grey); under Payment,
 * `paid`, the ways they say people paid, the commonest first ("Lightning, Cash"). Neither is drawn
 * when none of them gives one: null, and empty.
 */
export function Facts({
  place,
  now,
  locale,
  price,
  paid,
}: {
  place: Place;
  now: Date;
  locale: string;
  price: ReturnType<typeof priceOf>;
  paid: readonly Paid[];
}): JSX.Element {
  const state = useMemo(() => openState(place, now), [place, now]);
  const week = useMemo(() => weekTable(place, now, locale), [place, now, locale]);
  const address = addressOf(place);
  const call = actionsOf(place).call;

  let hours: ReactNode;
  if (state.kind === "unknown") hours = copy.place.hoursNotListed;
  else if (week !== null) hours = <WeekHours week={week} />;
  else hours = <p className="m-0 wrap-break-word">{place.openingHours}</p>;

  return (
    <dl className="m-0 flex flex-col gap-3 text-[15px] leading-[normal]">
      {address !== undefined && (
        <Fact label={copy.place.facts.address}>
          <Address text={address} />
        </Fact>
      )}
      <Fact label={copy.place.facts.hours} muted={state.kind === "unknown"}>
        {hours}
      </Fact>
      {price !== null && (
        <Fact label={copy.place.facts.price}>
          {/* Read out in words ("2 of 4", under the label Price), never as the signs one by one. */}
          <span role="img" aria-label={copy.place.priceSpoken(price.price)}>
            {copy.price.signs(price.price)}
          </span>{" "}
          <span className="text-muted">{copy.place.priceFrom(price.from)}</span>
        </Fact>
      )}
      {place.phone !== undefined && (
        <Fact label={copy.place.facts.phone}>
          {call === undefined ? (
            place.phone
          ) : (
            <a href={call} className="text-ink no-underline hover:text-accent hover:underline">
              {place.phone}
            </a>
          )}
        </Fact>
      )}
      {place.acceptsBitcoin !== undefined && (
        <Fact label={copy.place.facts.payment} centred>
          <span className="inline-block rounded-[10px] border-token border-line-strong px-2.5 py-[5px] text-caption font-semibold">
            {copy.place.bitcoin[place.acceptsBitcoin]}
          </span>
        </Fact>
      )}
      {paid.length > 0 && (
        <Fact label={copy.place.facts.paidWith}>{copy.place.paidWays(...paid.map((way) => copy.paid[way]))}</Fact>
      )}
    </dl>
  );
}
