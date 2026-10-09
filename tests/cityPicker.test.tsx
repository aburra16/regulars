import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copy } from "../src/copy/en";
import { CityPicker } from "../src/location/CityPicker";
import type { City } from "../src/places/indexes";
import { lockPage } from "../src/ui/lockPage";

// The picker lists `useIndexes()?.cities`. null: no indexes yet.
const override = vi.hoisted(() => ({ cities: [] as City[] | null }));
vi.mock("../src/places/useIndexes", () => ({
  useIndexes: () => (override.cities === null ? undefined : { cities: override.cities }),
}));

const city = (name: string, count: number, rest: Partial<City> = {}): City => ({
  name,
  country: "PT",
  lat: 10,
  lon: 20,
  count,
  ...rest,
});

const lisbon = city("Lisbon", 120, { lat: 38.7223, lon: -9.1393 });
const porto = city("Porto", 80);
const funchal = city("Funchal", 1);
const saoPaulo = city("São Paulo", 300, { country: "BR" });
const zurich = city("Zürich", 40, { country: "CH" });
const lexingtonKY = city("Lexington", 50, { country: "US", region: "KY" });
const lexingtonMA = city("Lexington", 9, { country: "US", region: "MA" });
// Towns of GeoNames, with the other names their places give them (folded, as the indexes keep them).
const prague = city("Prague", 31, { country: "CZ", geonameId: 3067696, aliases: ["hlavni mesto praha", "praha", "praha 10", "praha 8"] });
const lisbonGeo = city("Lisbon", 9, { geonameId: 2267057, aliases: ["lisboa"] });

afterEach(() => {
  override.cities = [];
});

function renderPicker(cities: City[] | null = [], handlers: Partial<Parameters<typeof CityPicker>[0]> = {}) {
  override.cities = cities;
  const props = { onPick: vi.fn(), onUseDevice: vi.fn(), onClose: vi.fn(), ...handlers };
  render(<CityPicker {...props} />);
  return props;
}

const dialog = () => screen.getByRole("dialog");
const filterField = () => screen.getByRole("searchbox", { name: copy.location.filterPlaceholder });
const useMineButton = () => screen.getByRole("button", { name: copy.location.useMine });
const closeButton = () => screen.getByRole("button", { name: copy.location.close });
/** The buttons of the cities, in the order they are listed. */
const cityRows = () => within(screen.getByRole("list")).getAllByRole("button");
const rowNames = () => cityRows().map((row) => row.textContent);

const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("CityPicker", () => {
  describe("as a dialog", () => {
    it("is a modal dialog named by its title", () => {
      renderPicker([lisbon]);
      expect(screen.getByRole("dialog", { name: copy.location.pickTitle })).toBe(dialog());
      expect(dialog()).toHaveAttribute("aria-modal", "true");
      expect(screen.getByRole("heading", { name: "Choose a place" })).toBeInTheDocument();
    });

    it("moves the focus to the filter field when it opens", () => {
      renderPicker([lisbon]);
      expect(filterField()).toHaveFocus();
    });

    it("closes on Escape", async () => {
      const user = userEvent.setup();
      const { onClose } = renderPicker([lisbon]);
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape when nothing in it has the focus", async () => {
      const user = userEvent.setup();
      const { onClose } = renderPicker([lisbon]);
      await user.click(screen.getByRole("heading"));
      expect(document.body).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes from its close button, and from a tap outside the dialog", async () => {
      const user = userEvent.setup();
      const { onClose } = renderPicker([lisbon]);
      await user.click(closeButton());
      expect(onClose).toHaveBeenCalledTimes(1);

      await user.click(dialog().parentElement!);
      expect(onClose).toHaveBeenCalledTimes(2);

      // A tap inside the dialog is not a tap outside it.
      await user.click(screen.getByRole("heading"));
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("stays open when a press that began inside it ends on the screen beside it", () => {
      const { onClose } = renderPicker([lisbon]);
      const scrim = dialog().parentElement!;
      // Selecting the text in the filter by dragging out past the dialog's edge: the browser
      // sends the click to the screen beside it, where the press ended.
      fireEvent.pointerDown(filterField());
      fireEvent.click(scrim);
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps the Tab key inside, wrapping from the last control to the first and back", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, porto]);
      const rows = cityRows();

      rows.at(-1)!.focus();
      await user.tab();
      expect(closeButton()).toHaveFocus();

      await user.tab({ shift: true });
      expect(rows.at(-1)).toHaveFocus();

      // And a Tab from outside it comes inside.
      (document.activeElement as HTMLElement).blur();
      await user.tab();
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    });

    it("gives the focus back to what had it, once it has closed", async () => {
      const user = userEvent.setup();
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>
              Open the picker
            </button>
            {open && <CityPicker onPick={() => {}} onUseDevice={() => {}} onClose={() => setOpen(false)} />}
          </>
        );
      }
      override.cities = [lisbon];
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Open the picker" });
      await user.click(opener);
      expect(filterField()).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
  });

  describe("the page behind it", () => {
    let root: HTMLDivElement;
    beforeEach(() => {
      root = document.createElement("div");
      root.id = "root";
      document.body.append(root);
    });
    afterEach(() => {
      root.remove();
      document.body.removeAttribute("style");
    });

    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open the picker
          </button>
          {open && <CityPicker onPick={() => {}} onUseDevice={() => {}} onClose={() => setOpen(false)} />}
        </>
      );
    }

    it("cannot be scrolled or reached while it is open, and can again once it has closed", async () => {
      const user = userEvent.setup();
      override.cities = [lisbon];
      document.body.style.overflow = "auto";
      render(<Page />, { container: root });

      await user.click(screen.getByRole("button", { name: "Open the picker" }));
      expect(root).toHaveAttribute("inert");
      expect(document.body.style.overflow).toBe("hidden");
      // The dialog is not inside the app's root, so it is not inert itself.
      expect(root).not.toContainElement(dialog());

      await user.keyboard("{Escape}");
      expect(root).not.toHaveAttribute("inert");
      expect(document.body.style.overflow).toBe("auto");
      expect(screen.getByRole("button", { name: "Open the picker" })).toHaveFocus();
    });

    it("stays locked until the last of two dialogs has closed", () => {
      const release = [lockPage(), lockPage()];
      expect(root).toHaveAttribute("inert");
      release[0]!();
      // Releasing the same lock twice does not release the other.
      release[0]!();
      expect(root).toHaveAttribute("inert");
      expect(document.body.style.overflow).toBe("hidden");
      release[1]!();
      expect(root).not.toHaveAttribute("inert");
      expect(document.body.style.overflow).toBe("");
    });
  });

  describe("what is in it", () => {
    it("shows the title, then 'Use my location', then the filter field, then the cities", () => {
      renderPicker([lisbon, porto]);
      const title = screen.getByRole("heading", { name: copy.location.pickTitle });
      const [first] = cityRows();
      expect(precedes(title, useMineButton())).toBe(true);
      expect(precedes(useMineButton(), filterField())).toBe(true);
      expect(precedes(filterField(), first!)).toBe(true);
    });

    it("lists each city's label and the number of its places, the biggest first", () => {
      renderPicker([funchal, lisbon, porto]);
      expect(rowNames()).toEqual(["Lisbon 120 places", "Porto 80 places", "Funchal 1 place"]);
      expect(cityRows()[0]).toHaveAccessibleName("Lisbon 120 places");
    });

    it("sorts by the number of places, whatever order the cities come in, keeping the order of ties", () => {
      renderPicker([city("Bravo", 5), city("Alpha", 5), city("Zulu", 90), city("Mike", 5)]);
      expect(cityRows().map((row) => row.textContent?.replace(/ \d+ places?$/, ""))).toEqual([
        "Zulu",
        "Bravo",
        "Alpha",
        "Mike",
      ]);
    });

    it("tells two towns of one name apart, as cityLabel does", () => {
      renderPicker([lexingtonKY, lexingtonMA, lisbon]);
      expect(rowNames()).toEqual(["Lisbon 120 places", "Lexington, KY 50 places", "Lexington, MA 9 places"]);
    });

    it("groups the thousands in a big count", () => {
      renderPicker([city("Metropolis", 7954)]);
      expect(cityRows()[0]).toHaveTextContent("7,954 places");
    });

    it("makes every control at least 44 px tall", () => {
      renderPicker([lisbon, porto, funchal]);
      for (const button of [closeButton(), useMineButton(), ...cityRows()]) expect(button).toHaveClass("min-h-touch");
    });

    it("lists the cities as plain buttons, so that each is reached with the Tab key", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, porto]);
      const [first, second] = cityRows();
      expect(first!.tagName).toBe("BUTTON");
      expect(first).toHaveAttribute("type", "button");
      first!.focus();
      await user.tab();
      expect(second).toHaveFocus();
    });

    it("shows the title and 'Use my location' while the towns are not known yet", () => {
      renderPicker(null);
      expect(dialog()).toBeInTheDocument();
      expect(useMineButton()).toBeInTheDocument();
      expect(filterField()).toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  describe("choosing", () => {
    it("hands over the city that was tapped, and nothing else happens", async () => {
      const user = userEvent.setup();
      const { onPick, onUseDevice, onClose } = renderPicker([lisbon, porto]);
      await user.click(within(dialog()).getByRole("button", { name: /^Porto/ }));
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith(porto);
      expect(onUseDevice).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("hands over the city with the Enter key", async () => {
      const user = userEvent.setup();
      const { onPick } = renderPicker([lisbon, porto]);
      cityRows()[0]!.focus();
      await user.keyboard("{Enter}");
      expect(onPick).toHaveBeenCalledWith(lisbon);
    });

    it("asks for the device's location when 'Use my location' is tapped", async () => {
      const user = userEvent.setup();
      const { onPick, onUseDevice } = renderPicker([lisbon]);
      await user.click(useMineButton());
      expect(onUseDevice).toHaveBeenCalledTimes(1);
      expect(onPick).not.toHaveBeenCalled();
    });

    it("does not ask for the location when it opens", () => {
      const { onUseDevice } = renderPicker([lisbon]);
      expect(onUseDevice).not.toHaveBeenCalled();
    });
  });

  describe("the filter", () => {
    it("starts with every city and has the placeholder 'Search towns and cities'", () => {
      renderPicker([lisbon, porto, funchal]);
      expect(filterField()).toHaveValue("");
      expect(filterField()).toHaveAttribute("placeholder", "Search towns and cities");
      expect(cityRows()).toHaveLength(3);
    });

    it("keeps the cities with the text anywhere in their label, whatever its case", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, porto, funchal, saoPaulo]);
      await user.type(filterField(), "RTO");
      expect(rowNames()).toEqual(["Porto 80 places"]);

      await user.clear(filterField());
      await user.type(filterField(), "Bon");
      expect(rowNames()).toEqual(["Lisbon 120 places"]);
    });

    it("ignores the accents of Latin letters, in what is typed and in the names", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, saoPaulo, zurich]);

      await user.type(filterField(), "sao");
      expect(rowNames()).toEqual(["São Paulo 300 places"]);

      await user.clear(filterField());
      await user.type(filterField(), "SÃO pa");
      expect(rowNames()).toEqual(["São Paulo 300 places"]);

      await user.clear(filterField());
      await user.type(filterField(), "zurich");
      expect(rowNames()).toEqual(["Zürich 40 places"]);

      await user.clear(filterField());
      await user.type(filterField(), "zürich");
      expect(rowNames()).toEqual(["Zürich 40 places"]);
    });

    it("ignores spaces at either end of what is typed", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, porto]);
      await user.type(filterField(), "  lisb ");
      expect(rowNames()).toEqual(["Lisbon 120 places"]);
    });

    it("matches the label that is shown, where it is told from another town's", async () => {
      const user = userEvent.setup();
      renderPicker([lexingtonKY, lexingtonMA, lisbon]);
      await user.type(filterField(), "lexington, ky");
      expect(rowNames()).toEqual(["Lexington, KY 50 places"]);

      await user.clear(filterField());
      await user.type(filterField(), "lex");
      expect(rowNames()).toEqual(["Lexington, KY 50 places", "Lexington, MA 9 places"]);
    });

    it("finds Prague by its name and by Praha, and leads praha 10 to Prague, showing only its name", async () => {
      const user = userEvent.setup();
      renderPicker([lisbonGeo, prague, porto]);
      for (const typed of ["Prague", "praha", "PRAHA 10", "praha  10"]) {
        await user.clear(filterField());
        await user.type(filterField(), typed);
        expect(rowNames()).toEqual(["Prague 31 places"]);
      }
    });

    it("finds Lisbon by Lisbon and by Lisboa", async () => {
      const user = userEvent.setup();
      const { onPick } = renderPicker([lisbonGeo, prague, porto]);
      await user.type(filterField(), "Lisbon");
      expect(rowNames()).toEqual(["Lisbon 9 places"]);
      await user.clear(filterField());
      await user.type(filterField(), "lisboa");
      expect(rowNames()).toEqual(["Lisbon 9 places"]);
      await user.click(cityRows()[0]!);
      expect(onPick).toHaveBeenCalledWith(lisbonGeo);
    });

    it("lists two towns of one name and country, told apart by nothing else, as two rows of their own", () => {
      // React says so on the console when two rows of a list have the same key.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const sanJose = city("San José", 12, { country: "CR", geonameId: 3621849 });
      const otherSanJose = city("San José", 3, { country: "CR", geonameId: 3621841 });
      renderPicker([sanJose, otherSanJose]);
      expect(cityRows()).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it("says so when nothing matches, and lists nothing", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon, porto]);
      await user.type(filterField(), "zzz");
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(copy.location.noMatch);

      await user.clear(filterField());
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(cityRows()).toHaveLength(2);
    });

    it("still offers 'Use my location' when nothing matches", async () => {
      const user = userEvent.setup();
      renderPicker([lisbon]);
      await user.type(filterField(), "zzz");
      expect(useMineButton()).toBeInTheDocument();
    });
  });

  describe("a long list", () => {
    const many = Array.from({ length: 60 }, (_, i) => city(`Town ${String(i).padStart(2, "0")}`, i + 1));

    it("shows the first 50 only, the biggest of them", () => {
      renderPicker(many);
      const rows = cityRows();
      expect(rows).toHaveLength(50);
      expect(rows[0]).toHaveTextContent("Town 59");
      expect(rows.at(-1)).toHaveTextContent("Town 10");
      expect(screen.queryByRole("button", { name: /^Town 09/ })).not.toBeInTheDocument();
    });

    it("shows the first 50 of the matches, and the matches below that bring the rest into view", async () => {
      const user = userEvent.setup();
      renderPicker(many);
      await user.type(filterField(), "town");
      expect(cityRows()).toHaveLength(50);

      await user.clear(filterField());
      await user.type(filterField(), "town 0");
      // Town 00 to Town 09, the biggest first.
      expect(cityRows()).toHaveLength(10);
      expect(cityRows()[0]).toHaveTextContent("Town 09");
    });

    it("lists a city that is not among the biggest 50 as soon as it is searched for", async () => {
      const user = userEvent.setup();
      renderPicker(many);
      expect(screen.queryByRole("button", { name: /^Town 03/ })).not.toBeInTheDocument();
      await user.type(filterField(), "town 03");
      expect(rowNames()).toEqual(["Town 03 4 places"]);
    });
  });
});
