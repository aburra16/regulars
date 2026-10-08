import { useLayoutEffect } from "react";

/**
 * Names the page in the browser's tab, history and bookmarks while the component is on screen.
 * When it goes, the title it replaced comes back, so a page that sets none does not keep the
 * last page's. The title changes as the page is drawn, in the same step, so nothing (a screen
 * reader, the history, a test) ever sees the new page under the old page's name.
 */
export function useDocumentTitle(title: string): void {
  useLayoutEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
