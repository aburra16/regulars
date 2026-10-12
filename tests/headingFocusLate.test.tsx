import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX, useContext, useEffect, useRef, useState } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ArrivalMark, HeadingIn, PlacedFocus, useHeadingFocus, usePlaceFocus } from "../src/shell/headingFocus";

/*
 * A heading that comes in after its page (src/shell/headingFocus.ts): the hook itself, in a frame of
 * the test's own that does with it what the shell's does. A page whose heading was due the focus and
 * was not in yet is owed it, and takes it once it says the heading is in (`HeadingIn`); the focus
 * owed to one page is never taken by another. (tests/headingFocus.test.tsx has the app's pages;
 * tests/personRoute.test.tsx the one page of the app whose heading comes late.)
 */

let router: ReturnType<typeof createMemoryRouter>;
/** Goes to another page as the app's own code does, having put the focus on `placeOn` on purpose first: set by the frame. */
let goOn: (to: string, placeOn: HTMLElement) => void;
/** Lets the heading of the page that draws it late come in. */
let headingComes: () => void;

/** What the app's own code does on the way to another page: it puts the focus somewhere on purpose, and goes. */
function Ways(): null {
  const place = usePlaceFocus();
  goOn = (to, placeOn) =>
    act(() => {
      place(placeOn);
      void router.navigate(to);
    });
  return null;
}

/** The frame, as the shell's: the mark, a link that stays whatever the page (as the top bar's do), and the page in `main`. */
function Frame(): JSX.Element {
  const main = useRef<HTMLElement>(null);
  const { arrival, placed, headingIn } = useHeadingFocus(main, true);
  return (
    <PlacedFocus value={placed}>
      <ArrivalMark at={arrival} />
      <Ways />
      <a href="#kept">kept</a>
      <main ref={main}>
        <HeadingIn value={headingIn}>
          <Outlet />
        </HeadingIn>
      </main>
    </PlacedFocus>
  );
}

/** A page with no heading, which says nothing of one: an address with no page, say. */
function Bare(): JSX.Element {
  return <p>nothing here</p>;
}

/** A page whose heading is there as it goes in, and which says so all the same, as a page whose code was fetched before does. */
function Ready({ name }: { name: string }): JSX.Element {
  const headingIn = useContext(HeadingIn);
  useEffect(() => headingIn?.(), [headingIn]);
  return <h1 tabIndex={-1}>{name}</h1>;
}

/** A page whose heading comes in later (`headingComes`), and which says so then. */
function Late(): JSX.Element {
  const headingIn = useContext(HeadingIn);
  const [drawn, setDrawn] = useState(false);
  headingComes = () => act(() => setDrawn(true));
  useEffect(() => {
    if (drawn) headingIn?.();
  }, [drawn, headingIn]);
  return drawn ? <h1 tabIndex={-1}>late</h1> : <p>fetching</p>;
}

function open(path: string) {
  router = createMemoryRouter(
    [
      {
        element: <Frame />,
        children: [
          { path: "start", element: <Ready name="start" /> },
          { path: "bare", element: <Bare /> },
          { path: "late", element: <Late /> },
          { path: "ready", element: <Ready name="ready" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

/** The frame's link that stays. */
const kept = () => screen.getByRole("link", { name: "kept" });
const heading = (name: string) => screen.getByRole("heading", { level: 1, name });
/** The person does something on the page: what comes next is their going. */
const act1 = () => userEvent.setup().click(document.body);

describe("a heading that comes in after its page", () => {
  it("takes the focus it was due once the page says it is in", async () => {
    open("/start");
    await act1();
    await act(() => router.navigate("/late"));
    expect(document.body).toHaveFocus();

    headingComes();

    expect(heading("late")).toHaveFocus();
  });

  it("takes nothing when the page was due nothing: the first page opened", () => {
    open("/late");

    headingComes();

    expect(heading("late")).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it("takes nothing when the person has moved the focus meanwhile", async () => {
    const user = userEvent.setup();
    open("/start");
    await user.click(document.body);
    await act(() => router.navigate("/late"));
    await user.tab();
    expect(kept()).toHaveFocus();

    headingComes();

    expect(heading("late")).toBeInTheDocument();
    expect(kept()).toHaveFocus();
  });

  it("is given the focus once only: a page that says it again moves nothing, though the focus is back where it was as the page went in", async () => {
    const user = userEvent.setup();
    open("/start");
    await user.click(document.body);
    await act(() => router.navigate("/late"));
    headingComes();
    expect(heading("late")).toHaveFocus();
    // The focus leaves the heading for nothing: where it was as the page went in, when the heading was owed it.
    act(() => heading("late").blur());
    expect(document.body).toHaveFocus();

    // The address gains a section's name: the page says its heading is in once more.
    await act(() => router.navigate("/late#again"));

    // What the page was owed it was given, once: nothing is owed it now, and nothing is moved.
    expect(document.body).toHaveFocus();
  });
});

describe("the focus owed to a page whose heading never came", () => {
  it("is not taken by the next page: where the app put the focus on purpose for that page change, it stays", async () => {
    open("/start");
    await act1();
    // A page with no heading: it was due the focus, and is owed it for as long as the person is on it.
    await act(() => router.navigate("/bare"));
    expect(document.body).toHaveFocus();

    // The app goes on to a page that says its heading is in, having put the focus on the link that stays.
    goOn("/ready", kept());

    expect(heading("ready")).toBeInTheDocument();
    // What was owed to the page before is not this page's to take: the focus is where the app put it.
    expect(kept()).toHaveFocus();
  });

  it("is forgotten once the person has gone on: the next page's heading has the focus by the frame's own rule", async () => {
    open("/start");
    await act1();
    await act(() => router.navigate("/bare"));

    await act(() => router.navigate("/ready"));

    expect(heading("ready")).toHaveFocus();
  });
});
