import { type JSX, type ReactNode, useId, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useWide } from "../shell/useWide.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { isPlainClick } from "../ui/plainClick.ts";
import { KindOptions, OpenNowSwitch, SortOptions, WithinOptions } from "./FilterControls.tsx";
import { cameFromExplore, type Filters, filtersFromParams, FROM_FILTERS, noFilters, sortInUse, withFilters } from "./filters.ts";
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
 * place. The page works on its own copy of them. "Show 5 places" goes to the search with that copy
 * in the address, in place of this page in the history; "Clear all" turns every filter off. The
 * cross goes back to where the page was opened from, as it was: Explore, when its More chip opened
 * it (`FROM_EXPLORE`, with the chip's own filter on here), or else the search. The words searched
 * for stay in the address. The ways to the search say they come from here (`FROM_FILTERS`), so the
 * search does not raise the keyboard over its results.
 *
 * A desktop has these same controls (FilterControls) as menus above its results, so there this page
 * gives its place in the history to the search with the same address, as the map's page gives its to
 * Explore.
 */
export function FiltersPage(): JSX.Element {
  useDocumentTitle(copy.titles.filters);
  const wide = useWide();
  const navigate = useNavigate();
  const locale = useLocale();
  const [params] = useSearchParams();
  const { state } = useLocation();
  const fromExplore = cameFromExplore(state);
  const query = (params.get("q") ?? "").trim();

  const [draft, setDraft] = useState<Filters>(() => {
    const asked = filtersFromParams(params, locale);
    return { ...asked, sort: sortInUse(asked) };
  });
  const change = (part: Partial<Filters>) => setDraft((current) => ({ ...current, ...part }));
  const { count, order } = useResults(query, draft);

  const apply = () =>
    void navigate(searchPath(withFilters(params, draft, locale).toString()), { replace: true, state: FROM_FILTERS });

  if (wide) return <Navigate to={searchPath(params.toString())} replace />;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between pt-3.5 pr-3 pl-5">
        <h1 className="m-0 font-display text-[26px] font-extrabold tracking-display">{copy.pages.filters}</h1>
        <Link
          replace
          to={fromExplore ? "/" : searchPath(params.toString())}
          state={fromExplore ? undefined : FROM_FILTERS}
          onClick={(event) => {
            // Opened from Explore: back to that Explore, with its chip, its depth and its scroll position.
            if (!fromExplore || !isPlainClick(event)) return;
            event.preventDefault();
            void navigate(-1);
          }}
          aria-label={copy.filters.close}
          className="flex size-11 items-center justify-center text-ink"
        >
          <CloseIcon size={22} />
        </Link>
      </div>

      <Section title={copy.filters.sortBy} className="pt-[18px]">
        {(headingId) => (
          <SortOptions value={draft.sort} order={order} onChange={(sort) => change({ sort })} labelledBy={headingId} />
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
            count === 0 ? "cursor-not-allowed bg-surface text-muted" : "cursor-pointer bg-accent-solid text-on-accent"
          }`}
        >
          {copy.filters.show(count)}
        </button>
      </div>
    </div>
  );
}
