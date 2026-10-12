import { afterEach, describe, expect, it, vi } from "vitest";

import { laterWordStarts } from "../src/places/words";

// The rest of a part of a name from each of its later words, where it is written without spaces
// (src/places/words.ts): what the search finds a word in the middle of a name by.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("laterWordStarts", () => {
  it("gives the rest of a Thai, Chinese or Japanese name from each of its later words", () => {
    expect(laterWordStarts("ร้านก๋วยเตี๋ยวแม่มาลี")).toEqual(["ก๋วยเตี๋ยวแม่มาลี", "แม่มาลี", "มาลี"]);
    expect(laterWordStarts("北京烤鸭店")).toEqual(["烤鸭店", "店"]);
    expect(laterWordStarts("こだわり麺や")).toEqual(["麺や", "や"]);
  });

  it("starts a word where the script changes to Latin letters or digits, or back", () => {
    // ไก่ ทอด: fried chicken. The breaker alone reads "KFCไก่" as one word.
    expect(laterWordStarts("KFCไก่ทอด")).toEqual(["ไก่ทอด", "ทอด"]);
    // The breaker alone reads "ร้าน123มาลี" as one word.
    expect(laterWordStarts("ร้าน123มาลี")).toEqual(["123มาลี", "มาลี"]);
    expect(laterWordStarts("カフェ2号店")).toContain("2号店");
  });

  it("keeps a Japanese word with a long vowel mark whole: the mark is no script's own", () => {
    expect(laterWordStarts("ペーパークレーン")).toEqual(["クレーン"]);
  });

  it("gives nothing for a part written in a script with spaces, letters and digits together or not", () => {
    expect(laterWordStarts("Café123")).toEqual([]);
    expect(laterWordStarts("Pizzaria")).toEqual([]);
    expect(laterWordStarts("돈카츠")).toEqual([]);
  });

  it("gives nothing where the browser has no word breaker, a change of script or not", () => {
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }) as typeof Intl);
    expect(laterWordStarts("KFCไก่ทอด")).toEqual([]);
    expect(laterWordStarts("ร้านก๋วยเตี๋ยวแม่มาลี")).toEqual([]);
  });
});
