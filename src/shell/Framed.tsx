import type { JSX } from "react";

import { copy } from "../copy/en.ts";

/*
 * The site in another site's frame. The Content Security Policy can't keep it out: it is a meta tag
 * (tools/csp.ts), which can't set frame-ancestors, and GitHub Pages sets no headers. So the app keeps
 * itself out (src/main.tsx): in a frame it draws only a link that opens the same page on its own,
 * where nothing on top of it can make a person tap what they can't see.
 */

/**
 * Whether the page is in another page's frame: its window is not the top one. A top window the page
 * can't read counts as another's.
 */
export function isFramed(win: Window = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** What a page in a frame draws in place of the app: one link, to the same address, opened as the top page. */
export function FramedLink(): JSX.Element {
  return (
    <main className="p-6">
      <a href={window.location.href} target="_top" className="font-semibold text-ink underline hover:text-accent">
        {copy.framed.open}
      </a>
    </main>
  );
}
