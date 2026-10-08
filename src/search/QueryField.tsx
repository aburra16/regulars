import { type FormEvent, type JSX, type Ref, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

import { copy } from "../copy/en.ts";
import { CloseIcon } from "../ui/icons.tsx";

/** How long after the last letter the field searches by itself. */
export const SEARCH_DELAY_MS = 250;

/** What the page can ask of the field: whether words are waiting to be searched for, and to search for them now. */
export interface QueryFieldHandle {
  /** Whether the person has typed words that the field has not searched for yet. */
  pending(): boolean;
  /** Searches for the words typed now, without waiting; resolves, with those words, once the address has them. */
  flush(): Promise<string>;
}

/**
 * The search field of the results on a phone (Search.dc.html): 52 px tall on the surface colour,
 * with a cross at its end that clears it. `value` is the words the address has. The field tells
 * its page what to search for when the person submits, and a quarter of a second after they stop
 * typing, as `query` without the spaces around it; it says nothing for a search the address has
 * already. When the address changes some other way (Back, the top bar's search), the field shows it.
 * A page that is about to leave can `flush` the field, so words that were typed a moment ago are kept.
 */
export function QueryField({
  value,
  onSearch,
  autoFocus,
  ref,
}: {
  value: string;
  /** Called with the words to search for. It may return the navigation it makes, so a caller can wait for it. */
  onSearch(query: string): void | Promise<void>;
  autoFocus: boolean;
  ref?: Ref<QueryFieldHandle>;
}): JSX.Element {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  // The search the address has, as far as the field knows. A search the field made is not news to it.
  const known = useRef(value);

  // What the field calls reads the page's latest `onSearch` and the latest `known`, so a search that was
  // waiting for the person to stop typing is made as the page is now, not as it was.
  const onSearchNow = useRef(onSearch);
  useEffect(() => {
    onSearchNow.current = onSearch;
  });
  const search = (query: string): void | Promise<void> => {
    if (query === known.current) return;
    known.current = query;
    return onSearchNow.current(query);
  };

  useImperativeHandle(ref, () => ({
    pending: () => text.trim() !== known.current,
    flush: async () => {
      const query = text.trim();
      await search(query);
      return query;
    },
  }));

  useEffect(() => {
    if (value === known.current) return;
    known.current = value;
    setText(value);
  }, [value]);

  useEffect(() => {
    const query = text.trim();
    if (query === known.current) return;
    const timer = setTimeout(() => search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    search(text.trim());
    // The keyboard has done its job; the results are behind it.
    input.current?.blur();
  };

  return (
    <form
      role="search"
      onSubmit={submit}
      className="flex h-13 min-w-0 flex-1 items-center gap-2.5 rounded-button bg-surface pr-1.5 pl-4 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ink"
    >
      <label htmlFor={inputId} className="sr-only">
        {copy.search.label}
      </label>
      <input
        ref={input}
        id={inputId}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={copy.search.placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        enterKeyHint="search"
        className="h-11 min-w-0 flex-1 border-0 bg-transparent p-0 font-text text-body font-semibold text-ink outline-none placeholder:font-normal placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text !== "" && (
        <button
          type="button"
          aria-label={copy.search.clear}
          onClick={() => {
            setText("");
            search("");
            input.current?.focus();
          }}
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted"
        >
          <CloseIcon size={18} />
        </button>
      )}
    </form>
  );
}
