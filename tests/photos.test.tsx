import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { copy } from "../src/copy/en";
import { PhotoStrip, ReviewPhotos, TILES_MAX } from "../src/ui/Photos";
import { PricePaid, pricePaidWords } from "../src/ui/PricePaid";

/*
 * The pieces that draw what a review carries besides its stars and words: its photos, as thumbnails
 * or as a link, the strip of a place's photos, and the line that says its price and how they paid.
 * Where each is drawn, and which reviews' photos are drawn rather than linked, is the pages' to say.
 */

const photos = (n: number) => Array.from({ length: n }, (_, i) => `https://blossom.example/${i + 1}.jpg`);
/** A link's name when it opens a new tab: its words, then that it does. */
const opensNew = (words: string) => `${words} ${copy.common.newTab}`;

afterEach(cleanup);

/** Every way an image must be asked for, and a link must open: lazily, with no referrer, in a new tab that cannot reach back. */
function expectSafe(img: HTMLElement, href: string): void {
  expect(img).toHaveAttribute("src", href);
  expect(img).toHaveAttribute("loading", "lazy");
  expect(img).toHaveAttribute("decoding", "async");
  expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  const link = img.closest("a")!;
  expect(link).toHaveAttribute("href", href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
}

describe("ReviewPhotos, drawn", () => {
  it("draws four thumbnails, each a link to its photo, and counts the rest in a tile that opens the fifth", () => {
    expect(TILES_MAX).toBe(4);
    const six = photos(6);
    render(<ReviewPhotos photos={six} drawn reviewer="Maya" />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(4);
    images.forEach((img, i) => {
      // Each named apart from the others: which of the review's photos it is, and whose review.
      expect(img).toHaveAttribute("alt", `Photo ${i + 1} of 6 from a review by Maya`);
      expect(screen.getByRole("link", { name: opensNew(`Photo ${i + 1} of 6 from a review by Maya`) })).toBe(img.closest("a"));
      expectSafe(img, six[i]!);
    });
    // "+2" to the eye; what it is, to a screen reader.
    const more = screen.getByRole("link", { name: opensNew("2 more photos from a review by Maya") });
    expect(within(more).getByText("+2")).toHaveAttribute("aria-hidden", "true");
    expect(more).toHaveAttribute("href", six[4]);
    expect(more).toHaveAttribute("target", "_blank");
    expect(more).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(more).queryByRole("img")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("draws four thumbnails of a review with 30 photos, and counts the other 26", () => {
    render(<ReviewPhotos photos={photos(30)} drawn reviewer="Maya" />);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(
      [1, 2, 3, 4].map((n) => `Photo ${n} of 30 from a review by Maya`),
    );
    const more = screen.getByRole("link", { name: opensNew("26 more photos from a review by Maya") });
    expect(more).toHaveAttribute("href", photos(30)[4]);
    expect(within(more).getByText("+26")).toBeInTheDocument();
  });

  it("draws up to four with no count tile", () => {
    render(<ReviewPhotos photos={photos(4)} drawn reviewer="Maya" />);
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(screen.getAllByRole("link")).toHaveLength(4);
    cleanup();
    render(<ReviewPhotos photos={photos(1)} drawn reviewer="Maya" />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    // The one photo of a review needs no number.
    expect(screen.getByRole("link", { name: opensNew("Photo from a review by Maya") })).toHaveAttribute("href", photos(1)[0]);
  });

  it("lays a review's tiles out in one row that never wraps: each its share of the row, at most 72 px on a phone and 80 on a desktop, never less than a touch target", () => {
    render(<ReviewPhotos photos={photos(6)} drawn reviewer="Maya" />);
    const row = screen.getByRole("list");
    expect(row).toHaveClass("flex", "flex-nowrap");
    expect(row.className).not.toMatch(/(?:^|\s)(?:wide:)?flex-wrap(?:\s|$)/);
    const items = within(row).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item).toHaveClass("flex-1", "min-w-touch", "max-w-[72px]", "wide:max-w-20");
      // A square as wide as its share, whatever is in it: a thumbnail, or the count.
      expect(item.querySelector("a")).toHaveClass("aspect-square", "w-full");
    }
  });

  it("draws nothing for a review with no photos", () => {
    const { container } = render(<ReviewPhotos photos={[]} drawn reviewer="Maya" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("takes away the tile of a photo that fails to load, and the next one takes its place", () => {
    const six = photos(6);
    render(<ReviewPhotos photos={six} drawn reviewer="Maya" />);
    fireEvent.error(screen.getAllByRole("img")[1]!);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([six[0], six[2], six[3], six[4]]);
    // Numbered among those left.
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(
      [1, 2, 3, 4].map((n) => `Photo ${n} of 5 from a review by Maya`),
    );
    expect(screen.getByRole("link", { name: opensNew("1 more photo from a review by Maya") })).toHaveAttribute("href", six[5]);
  });

  it("draws nothing once every photo has failed to load", () => {
    const { container } = render(<ReviewPhotos photos={photos(2)} drawn reviewer="Maya" />);
    for (const img of screen.getAllByRole("img")) fireEvent.error(img);
    expect(container).toBeEmptyDOMElement();
  });

  it("dims the photos and the count for a folded review", () => {
    render(<ReviewPhotos photos={photos(5)} drawn reviewer="Maya" muted />);
    for (const img of screen.getAllByRole("img")) expect(img).toHaveClass("opacity-60");
    expect(screen.getByRole("link", { name: opensNew("1 more photo from a review by Maya") })).toHaveClass("text-muted");
  });

  it("neither draws, links nor counts a photo at an address that is not https", () => {
    const [first, second] = photos(2);
    const given = ["http://blossom.example/a.jpg", first!, "javascript:alert(1)", "data:image/png;base64,AA==", second!, "photo"];
    render(<ReviewPhotos photos={given} drawn reviewer="Maya" />);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([first, second]);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([first, second]);
  });
});

describe("ReviewPhotos, not drawn", () => {
  it("is one link to the first photo, which says how many there are, and fetches none", () => {
    const two = photos(2);
    render(<ReviewPhotos photos={two} drawn={false} reviewer="Maya" />);
    expect(screen.queryAllByRole("img")).toEqual([]);
    expect(document.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: opensNew("2 photos") });
    expect(link).toHaveAttribute("href", two[0]);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("says Photo for one", () => {
    render(<ReviewPhotos photos={photos(1)} drawn={false} reviewer="Maya" />);
    expect(screen.getByRole("link", { name: opensNew("Photo") })).toHaveAttribute("href", photos(1)[0]);
  });

  it("is in the muted colour for a folded review", () => {
    render(<ReviewPhotos photos={photos(3)} drawn={false} reviewer="Maya" muted />);
    expect(screen.getByRole("link", { name: opensNew("3 photos") })).toHaveClass("text-muted");
  });

  it("counts only the https photos, and links the first of them", () => {
    const [first, second] = photos(2);
    render(<ReviewPhotos photos={["javascript:alert(1)", first!, "http://blossom.example/a.jpg", second!]} drawn={false} reviewer="Maya" />);
    expect(screen.getByRole("link", { name: opensNew("2 photos") })).toHaveAttribute("href", first);
  });

  it("is nothing for no photos, or none at an https address", () => {
    const { container } = render(<ReviewPhotos photos={[]} drawn={false} reviewer="Maya" />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const again = render(<ReviewPhotos photos={["http://blossom.example/a.jpg"]} drawn={false} reviewer="Maya" />);
    expect(again.container).toBeEmptyDOMElement();
  });
});

describe("PhotoStrip", () => {
  it("is a list named for the place, each tile a link to its photo with an image that names the place", () => {
    const three = photos(3);
    render(<PhotoStrip photos={three} placeName="Jacafé" />);
    const strip = screen.getByRole("list", { name: "Photos of Jacafé" });
    const images = within(strip).getAllByRole("img");
    expect(images).toHaveLength(3);
    images.forEach((img, i) => {
      expect(img).toHaveAttribute("alt", `Photo ${i + 1} of 3 of Jacafé`);
      expect(within(strip).getByRole("link", { name: opensNew(`Photo ${i + 1} of 3 of Jacafé`) })).toBe(img.closest("a"));
      expectSafe(img, three[i]!);
    });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(3);
  });

  it("names the one photo of a strip that has one without a number", () => {
    render(<PhotoStrip photos={photos(1)} placeName="Jacafé" />);
    expect(screen.getByRole("link", { name: opensNew("Photo of Jacafé") })).toHaveAttribute("href", photos(1)[0]);
  });

  it("is nothing with no photos", () => {
    const { container } = render(<PhotoStrip photos={[]} placeName="Jacafé" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("takes away the tile of a photo that fails to load", () => {
    const three = photos(3);
    render(<PhotoStrip photos={three} placeName="Jacafé" />);
    fireEvent.error(screen.getAllByRole("img")[0]!);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([three[1], three[2]]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("goes, with no list or name left, once every photo has failed to load", () => {
    const { container } = render(<PhotoStrip photos={photos(3)} placeName="Jacafé" />);
    for (const img of screen.getAllByRole("img")) fireEvent.error(img);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByLabelText("Photos of Jacafé")).toBeNull();
  });

  it("draws no photo at an address that is not https", () => {
    const [first] = photos(1);
    render(<PhotoStrip photos={["http://blossom.example/a.jpg", first!, "javascript:alert(1)"]} placeName="Jacafé" />);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([first]);
    cleanup();
    const again = render(<PhotoStrip photos={["data:image/png;base64,AA=="]} placeName="Jacafé" />);
    expect(again.container).toBeEmptyDOMElement();
  });
});

describe("PricePaid", () => {
  it("says the price and how they paid in one line, the price read out in words", () => {
    render(<PricePaid price={2} paid="lightning" />);
    const price = screen.getByRole("img", { name: "Price: 2 of 4" });
    expect(price).toHaveTextContent(/^\$\$$/);
    expect(price.parentElement).toHaveTextContent(/^\$\$ · Paid with Lightning$/);
  });

  it("says the price alone, or how they paid alone", () => {
    const { container } = render(<PricePaid price={2} paid={null} />);
    expect(container).toHaveTextContent(/^\$\$$/);
    cleanup();
    const paid = render(<PricePaid price={null} paid="cash" />);
    expect(paid.container).toHaveTextContent(/^Paid with Cash$/);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names each price and each way as the record's values say", () => {
    for (const n of [1, 2, 3, 4] as const) {
      render(<PricePaid price={n} paid={null} />);
      expect(screen.getByRole("img", { name: `Price: ${n} of 4` })).toHaveTextContent("$".repeat(n));
      cleanup();
    }
    const said = { lightning: "Lightning", onchain: "On-chain", card: "Card", cash: "Cash" } as const;
    for (const [paid, words] of Object.entries(said) as [keyof typeof said, string][]) {
      const { container } = render(<PricePaid price={null} paid={paid} />);
      expect(container).toHaveTextContent(`Paid with ${words}`);
      cleanup();
    }
  });

  it("is in the muted colour for a folded review", () => {
    const { container } = render(<PricePaid price={3} paid="card" muted />);
    expect(container.firstElementChild).toHaveClass("text-muted");
  });

  it("is nothing when the review gives neither", () => {
    const { container } = render(<PricePaid price={null} paid={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the same in words, for a link's description, where the signs are not read out", () => {
    expect(pricePaidWords(2, "lightning")).toBe("Price: 2 of 4 · Paid with Lightning");
    expect(pricePaidWords(2, null)).toBe("Price: 2 of 4");
    expect(pricePaidWords(null, "cash")).toBe("Paid with Cash");
    expect(pricePaidWords(null, null)).toBe("");
  });
});
