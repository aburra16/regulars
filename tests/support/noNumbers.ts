import { screen } from "@testing-library/react";
import { expect } from "vitest";

/*
 * Decision 19: a place shows its rating; a person never shows a trust number, rank, weight or meter.
 * The guard below looks for the numbers a test's ranks would give, in every form a page could show
 * them, and for the words that would come with one, whichever point of view is on screen.
 */

/** A number as a pattern: its dots taken literally. */
const literal = (value: string) => value.replace(/\./g, "\\.");

/**
 * Every form of each rank in `ranks` that a page could show: as given ("87.37"), to one decimal
 * ("87.4"), as a whole number when it has two digits or more ("87": a single digit would be any star
 * count), and as a weight, the rank out of 100, to four and to two decimals ("0.8737", "0.87").
 */
function formsOf(rank: number): string[] {
  const weight = rank / 100;
  const forms = [literal(String(rank)), `${literal(rank.toFixed(1))}\\b`, literal(weight.toFixed(4)), literal(weight.toFixed(2))];
  const whole = Math.trunc(rank);
  if (whole >= 10) forms.push(`\\b${whole}\\b`);
  return forms;
}

/**
 * Fails when the page shows a number about a person (any form of `ranks`, the ranks the test's
 * scorers gave), or the words that would say one ("rank", "weight", "counts for", "trust score", a
 * percentage), in its text or in what a screen reader hears; or a meter or a progress bar.
 *
 * `allow` names whole phrases the page's text may say that would otherwise match, each taken out of
 * the text before it is read: a sentence about how the sums work, never about a person ("Closer
 * people count for more", the Why page's rule in the design's words). Each must be on the page, so
 * that an allowance that no longer applies is not left behind. Names, descriptions and labels get none.
 */
export function expectNoNumbersAboutPeople(ranks: readonly number[], { allow = [] }: { allow?: readonly string[] } = {}): void {
  const aboutPeople = new RegExp(
    [...ranks.flatMap(formsOf), "%", "\\brank", "\\bweight", "\\bcounts? for", "trust score"].join("|"),
    "i",
  );
  const text = document.body.textContent ?? "";
  for (const phrase of allow) expect(text).toContain(phrase);
  expect(allow.reduce((left, phrase) => left.split(phrase).join(" "), text)).not.toMatch(aboutPeople);
  for (const element of document.body.querySelectorAll("*")) {
    // What a screen reader hears as a name or a description is held to it whole: nothing is allowed there.
    for (const attribute of ["aria-label", "aria-description", "title", "alt", "aria-valuetext", "aria-valuenow"]) {
      expect(element.getAttribute(attribute) ?? "").not.toMatch(aboutPeople);
    }
    expect(element).not.toHaveAccessibleName(aboutPeople);
    expect(element).not.toHaveAccessibleDescription(aboutPeople);
  }
  expect(screen.queryAllByRole("meter")).toEqual([]);
  expect(screen.queryAllByRole("progressbar")).toEqual([]);
}
