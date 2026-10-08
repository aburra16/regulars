import { describe, expect, it } from "vitest";

import { scriptLang } from "../src/ui/scriptLang";

describe("scriptLang", () => {
  it.each<[string, string, string | undefined]>([
    ["Japanese with kana", "ペーパー・クレーン", "ja"],
    ["Hiragana only", "ひらがなのみせ", "ja"],
    ["kanji and kana together", "寿司ざんまい", "ja"],
    ["Latin with Japanese", "Paper Crane ペーパー", "ja"],
    ["half-width katakana", "ﾗｰﾒﾝ", "ja"],
    ["Han with no kana", "北京烤鸭店", "zh"],
    ["Hangul", "서울식당", "ko"],
    ["Hangul with Han", "서울 食堂", "ko"],
    ["Thai", "ร้านอาหารไทย", "th"],
    ["Arabic", "مطعم الأصالة", "ar"],
    ["Cyrillic", "Ресторан Берёзка", "ru"],
    ["Latin", "Restaurante Tradicional Madeirense", undefined],
    ["Latin with accents", "Pátio Brunch & Bistro", undefined],
    ["Greek, which has no font of its own to choose", "Ελληνικό", undefined],
    ["digits and punctuation", "42 · (7)", undefined],
    ["empty", "", undefined],
  ])("%s: %s gives %j", (_label, name, lang) => {
    expect(scriptLang(name)).toBe(lang);
  });
});
