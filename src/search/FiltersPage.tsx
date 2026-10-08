import { type JSX, type ReactNode, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { KindOptions, OpenNowSwitch, SortOptions, WithinOptions } from "./FilterControls.tsx";
import { type Filters, filtersFromParams, FROM_FILTERS, noFilters, sortInUse, withFilters } from "./filters.ts";
import { useResults } from "./useResults.ts";

/** Where the search page is for an address's text: no text, no question mark. */
const searchPath = (query: string) => (query === "" ? "/search" : `/search?${query}`);

/** A group of controls under its heading; `children` gets the heading's id, to name the group by. */
function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: (headingId: string) => ReactNode;
  className: string;
}): JSX.Element {
  const headingId = useId();
  return (
    <section className={`flex flex-col gap-2.5 px-gutter-phone ${className}`}>
      <h2 id={headingId} className="m-0 text-body font-bold">
        {title}
      </h2>
      {children(headingId)}
    </section>
  );
}

/**
 * The filters (Filters.dc.html; screen 4): how to sort, Open now, how far, and which kinds of
 * place. The page works on its own copy of them. "Show 5 places" goes back to the search with that
 * copy in the address, in place of this page in the history; "Clear all" turns every filter off;
 * the cross goes back as the search was. The words searched for stay in the address. Both ways back
 * say they come from here (`FROM_FILTERS`), so the search does not raise the keyboard over its results.
 *
 * (The desktop's Explore shows these same controls, from FilterControls, as menus.)
 */
export function FiltersPage(): JSX.Element {
  useDocumentTitle(copy.titles.filters);
  const navigate = useNavigate();
  const locale = useLocale();
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();

  const [draft, setDraft] = useState<Filters>(() => {
    const asked = filtersFromParams(params, locale);
    return { ...asked, sort: sortInUse(asked) };
  });
  const change = (part: Partial<Filters>) => setDraft((current) => ({ ...current, ...part }));
  const { entries } = useResults(query, draft);
  const count = entries.length;

  const apply = () =>
    void navigate(searchPath(withFilters(params, draft, locale).toString()), { replace: true, state: FROM_FILTERS });

  return (
    <div className="flex flex-1 flex-col wide:mx-auto wide:w-list">
      <div className="flex items-center justify-between pt-3.5 pr-3 pl-5">
        <h1 className="m-0 font-display text-[26px] font-extrabold tracking-display">{copy.pages.filters}</h1>
        <Link
          replace
          to={searchPath(params.toString())}
          state={FROM_FILTERS}
          aria-label={copy.filters.close}
          className="flex size-11 items-center justify-center text-ink"
        >
          <CloseIcon size={22} />
        </Link>
      </div>

      <Section title={copy.filters.sortBy} className="pt-[18px]">
        {(headingId) => (
          <SortOptions value={draft.sort} onChange={(sort) => change({ sort })} labelledBy={headingId} />
        )}
      </Section>

      <div className="mt-5 px-gutter-phone">
        <OpenNowSwitch checked={draft.open} onChange={(open) => change({ open })} />
      </div>

      <Section title={copy.filters.distance} className="pt-5">
        {(headingId) => (
          <WithinOptions
            value={draft.withinKm}
            onChange={(withinKm) => change({ withinKm })}
            locale={locale}
            labelledBy={headingId}
          />
        )}
      </Section>

      <Section title={copy.filters.kinds} className="pt-[22px] pb-5">
        {(headingId) => (
          <KindOptions value={draft.families} onChange={(families) => change({ families })} labelledBy={headingId} />
        )}
      </Section>

      {/* Said aloud, politely, whenever a filter changes how many places there are. Always there, so the change is announced. */}
      <p role="status" className="sr-only">
        {copy.filters.countStatus(count)}
      </p>

      <div className="sticky bottom-0 mt-auto flex items-center gap-3 border-t-token border-line bg-ground px-gutter-phone pt-4 pb-[26px]">
        <button
          type="button"
          onClick={() => setDraft(noFilters(locale))}
          className="h-14 cursor-pointer border-0 bg-transparent px-[18px] font-text text-body font-bold text-ink"
        >
          {copy.filters.clearAll}
        </button>
        <button
          type="button"
          disabled={count === 0}
          onClick={apply}
          className={`flex h-14 flex-1 items-center justify-center rounded-[18px] border-0 font-text text-[17px] font-bold ${
            count === 0 ? "cursor-not-allowed bg-surface text-muted" : "cursor-pointer bg-accent text-on-accent"
          }`}
        >
          {copy.filters.show(count)}
        </button>
      </div>
    </div>
  );
}
