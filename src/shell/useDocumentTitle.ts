import { useEffect } from "react";

/**
 * Names the page in the browser's tab, history and bookmarks while the component is on screen.
 * When it goes, the title it replaced comes back, so a page that sets none does not keep the
 * last page's.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
