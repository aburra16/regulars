import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
