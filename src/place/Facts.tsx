import { type JSX, type ReactNode, useMemo } from "react";

import { copy } from "../copy/en.ts";
import { openState, weekTable } from "../places/hours.ts";
import type { Place } from "../places/place.ts";
import { unbrokenPostcodes } from "../ui/address.ts";
import { actionsOf } from "./Actions.tsx";

/**
 * The address as one line: the street address, then the town and the postcode where it does not
 * already name them (the importer writes most addresses whole: "138 Rua dos Ferreiros Funchal
 * 9000-082"), with the postcode kept whole on its line. Nothing when the place has none of them.
 */
export function addressOf(place: Pick<Place, "street" | "locality" | "postalCode">): string | undefined {
  let line = place.street?.trim() ?? "";
  for (const part of [place.locality, place.postalCode]) {
    const text = part?.trim();
    if (text === undefined || text === "" || line.toLowerCase().includes(text.toLowerCase())) continue;
    line = line === "" ? text : `${line} ${text}`;
  }
  return line === "" ? undefined : unbrokenPostcodes(line);
}

/** A fact: its label at 74 px, and what it says beside it (Place.dc.html). A fact with nothing to say is not drawn. */
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
 * What is known about a place (Place.dc.html, PlaceNew.dc.html): its address, its hours, its phone
 * and, when it takes bitcoin, a payment row with the chip. Hours are always there, "Not listed" in
 * grey when there are none; any other fact the place lacks is left out, never drawn empty. Hours the
 * app can read are the week ahead as a table; hours it cannot are as written. Everything here came
 * from a relay, so every value wraps rather than push the page wider.
 */
export function Facts({ place, now, locale }: { place: Place; now: Date; locale: string }): JSX.Element {
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
      {address !== undefined && <Fact label={copy.place.facts.address}>{address}</Fact>}
      <Fact label={copy.place.facts.hours} muted={state.kind === "unknown"}>
        {hours}
      </Fact>
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
            {copy.place.bitcoinChip}
          </span>
        </Fact>
      )}
    </dl>
  );
}
