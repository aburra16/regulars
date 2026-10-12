import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { copy } from "../src/copy/en";
import { FramedLink, isFramed } from "../src/shell/Framed";
import { APP_ROOT_ID } from "../src/ui/lockPage";

// The site in another site's frame: the policy can't keep it out (a meta tag can't set
// frame-ancestors; tools/csp.ts), so the app keeps itself out, and shows a link that opens it as a
// page of its own (src/shell/Framed.tsx, src/main.tsx).

const ownTop = Object.getOwnPropertyDescriptor(window, "top")!;

/** The page as if it were in a frame of another page, whose window is `top`. */
function framedIn(top: object) {
  Object.defineProperty(window, "top", { configurable: true, writable: true, value: top });
}

afterEach(() => {
  Object.defineProperty(window, "top", ownTop);
  document.getElementById(APP_ROOT_ID)?.remove();
});

describe("isFramed", () => {
  it("is no for a page that is its own top window, and yes for one in another's frame", () => {
    const own = {} as Window;
    expect(isFramed({ top: own, self: own } as unknown as Window)).toBe(false);
    expect(isFramed({ top: {}, self: own } as unknown as Window)).toBe(true);
    expect(isFramed()).toBe(false);
  });

  it("is yes for a page whose top window can't be read", () => {
    const own = {} as Window;
    const sealed = {
      self: own,
      get top(): Window {
        throw new DOMException("Blocked a frame from accessing a cross-origin frame", "SecurityError");
      },
    };
    expect(isFramed(sealed as unknown as Window)).toBe(true);
  });
});

describe("the page in a frame", () => {
  it("is a link that opens the same address as a page of its own, and nothing else", () => {
    window.history.replaceState(null, "", "/place/osm-node-1?x=1#reviews");
    render(<FramedLink />);
    const link = screen.getByRole("link", { name: copy.framed.open });
    expect(link).toHaveAttribute("href", window.location.href);
    expect(link.getAttribute("href")).toContain("/place/osm-node-1?x=1#reviews");
    expect(link).toHaveAttribute("target", "_top");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("is what the app's start draws in a frame, in place of the app", async () => {
    const root = document.createElement("div");
    root.id = APP_ROOT_ID;
    document.body.append(root);
    framedIn({});

    await import("../src/main");

    await waitFor(() => expect(root.querySelector("a")).not.toBeNull());
    const link = root.querySelector("a")!;
    expect(link.textContent).toBe(copy.framed.open);
    expect(link.getAttribute("target")).toBe("_top");
    // Nothing of the app: no tabs, no places loading.
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.textContent).toBe(copy.framed.open);
  });
});
