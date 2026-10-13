import type { JSX } from "react";

import { scriptLang } from "./scriptLang.ts";

/** Where a person's name goes in a line that names them. */
const NAME_MARK = "\u0000";

/**
 * A line with a person's name in it, the name kept apart from the sentence's direction, and marked
 * with the language of the script it is written in (`scriptLang`). `line` makes the sentence around
 * a name: the words stay the copy's, and the name is drawn where the line puts it.
 */
export function Named({ line, name }: { line: (name: string) => string; name: string }): JSX.Element {
  const [before = "", after = ""] = line(NAME_MARK).split(NAME_MARK);
  return (
    <>
      {before}
      <bdi lang={scriptLang(name)}>{name}</bdi>
      {after}
    </>
  );
}
