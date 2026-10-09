import { afterEach, describe, expect, it } from "vitest";

import { HANDHELD_QUERY, isHandheld } from "../src/signin/handheld";

/*
 * Whether the device is a phone or a tablet, which the phone app the person signs in with may be on:
 * judged by the device, never by the window's width. `matchMedia` is the test's: it answers for a
 * device whose main pointer is `pointer` and which can or cannot `hover`, in a window `width` wide.
 */

/** A browser whose device has this pointer and hover, in a window this wide. */
function device({ pointer, hover, width }: { pointer: "coarse" | "fine"; hover: "hover" | "none"; width: number }) {
  const features: Record<string, (value: string) => boolean> = {
    pointer: (value) => value === pointer,
    hover: (value) => value === hover,
    "min-width": (value) => width >= Number.parseInt(value, 10),
  };
  window.matchMedia = ((query: string) => {
    const conditions = [...query.matchAll(/\(([\w-]+):\s*([^)]+)\)/g)];
    const matches = conditions.length > 0 && conditions.every(([, name, value]) => features[name!]?.(value!.trim()) ?? false);
    return { media: query, matches, addEventListener: () => {}, removeEventListener: () => {} };
  }) as unknown as typeof window.matchMedia;
}

/** What the browser says of the device (User-Agent Client Hints), where it says anything. */
function hints(mobile: boolean | undefined) {
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: mobile === undefined ? undefined : { mobile } });
}

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(navigator, "userAgentData");
});

describe("isHandheld", () => {
  it("asks for a device whose main pointer is coarse and which cannot hover", () => {
    expect(HANDHELD_QUERY).toBe("(pointer: coarse) and (hover: none)");
  });

  it("is a phone or tablet whatever the window's width: a phone, and a tablet laid out as a desktop", () => {
    device({ pointer: "coarse", hover: "none", width: 390 });
    expect(isHandheld()).toBe(true);
    device({ pointer: "coarse", hover: "none", width: 1180 });
    expect(isHandheld()).toBe(true);
  });

  it("is not a computer, however narrow its window, nor a laptop with a touch screen, which hovers", () => {
    device({ pointer: "fine", hover: "hover", width: 390 });
    expect(isHandheld()).toBe(false);
    device({ pointer: "coarse", hover: "hover", width: 1360 });
    expect(isHandheld()).toBe(false);
  });

  it("is a phone or tablet where the browser says the device is mobile, whatever its pointer", () => {
    device({ pointer: "fine", hover: "hover", width: 1360 });
    hints(true);
    expect(isHandheld()).toBe(true);
  });

  it("goes by the pointer where the browser says the device is not mobile, as an Android tablet's does", () => {
    device({ pointer: "coarse", hover: "none", width: 1280 });
    hints(false);
    expect(isHandheld()).toBe(true);
  });

  it("is not, in a browser with no matchMedia that says nothing of the device", () => {
    Reflect.deleteProperty(window, "matchMedia");
    expect(isHandheld()).toBe(false);
  });
});
