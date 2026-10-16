import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { copy } from "../src/copy/en";
import { ReviewPhotos } from "../src/ui/Photos";
import { PricePaid } from "../src/ui/PricePaid";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";

/*
 * The guard of decision 19 (tests/support/noNumbers.ts), and the one way it lets a phrase through
 * (`allow`): whole phrases of a page's text that say how the sums work, never a number on a person.
 */

const RULE = "Closer people count for more";

describe("the guard against numbers on people", () => {
  it("catches the words that would say how much a person counts", () => {
    render(<p>{RULE}. Someone you trust outweighs someone a friend of a friend trusts.</p>);
    expect(() => expectNoNumbersAboutPeople([])).toThrow();
  });

  it("lets a phrase allowed through, as the page's text says it, and nothing else", () => {
    render(<p>{RULE}. Someone you trust outweighs someone a friend of a friend trusts.</p>);
    expect(() => expectNoNumbersAboutPeople([], { allow: [RULE] })).not.toThrow();
  });

  it("still catches the same words elsewhere in the text, and a person's rank, with a phrase allowed", () => {
    const { unmount } = render(
      <>
        <p>{RULE}.</p>
        <p>Maya counts for a lot.</p>
      </>,
    );
    expect(() => expectNoNumbersAboutPeople([], { allow: [RULE] })).toThrow();
    unmount();
    render(
      <>
        <p>{RULE}.</p>
        <p>Maya 87.37</p>
      </>,
    );
    expect(() => expectNoNumbersAboutPeople([87.37], { allow: [RULE] })).toThrow();
  });

  it("allows nothing in what a screen reader hears as a name, a description or a label", () => {
    render(
      <>
        <p>{RULE}.</p>
        <button type="button" aria-label={RULE}>
          More
        </button>
      </>,
    );
    expect(() => expectNoNumbersAboutPeople([], { allow: [RULE] })).toThrow();
  });

  it("fails when a phrase allowed is not on the page, so an allowance is not left behind", () => {
    render(<p>Only your circle counts.</p>);
    expect(() => expectNoNumbersAboutPeople([], { allow: [RULE] })).toThrow();
  });

  it("lets through what is counted of a review or a place beside a name: its photos, its price, how many reviews give one", () => {
    const photos = (n: number) => Array.from({ length: n }, (_, i) => `https://blossom.example.test/${i + 1}.jpg`);
    const said = () =>
      render(
        <>
          <ReviewPhotos photos={photos(6)} drawn reviewer="Maya" />
          <ReviewPhotos photos={photos(2)} drawn={false} reviewer="Maya" />
          <PricePaid price={2} paid="lightning" />
          <p>{copy.place.priceFrom(3)}</p>
        </>,
      );
    const { unmount } = said();
    expect(() => expectNoNumbersAboutPeople([87.37])).not.toThrow();
    unmount();
    // A rank beside them is still caught.
    said();
    render(<p>Maya 87.37</p>);
    expect(() => expectNoNumbersAboutPeople([87.37])).toThrow();
  });
});
