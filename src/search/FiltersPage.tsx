import { type JSX, type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { KindOptions, OpenNowSwitch, SortOptions, WithinOptions } from "./FilterControls.tsx";
import { type Filters, filtersFromParams, noFilters, sortInUse, withFilters } from "./filters.ts";
import { useResults } from "./useResults.ts";

/** Where the search page is for an address's text: no text, no question mark. */
const searchPath = (query: string) => (query === "" ? "/search" : `/search?${query}`);

function Section({ title, children, className }: { title: string; children: ReactNode; className: string }): JSX.Element {
  return (
    <section className={`flex flex-col gap-2.5 px-gutter-phone ${className}`}>
      <h2 className="m-0 text-body font-bold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The filters (Filters.dc.html; screen 4): how to sort, Open now, how far, and which kinds of
 * place. The page works on its own copy of them. "Show 5 places" goes back to the search with that
 * copy in the address, in place of this page in the history; "Clear all" turns every filter off;
 * the cross goes back as the search was. The words searched for stay in the address.
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
    const asked = filtersFromParams(params);
    return { ...asked, sort: sortInUse(asked) };
  });
  const change = (part: Partial<Filters>) => setDraft((current) => ({ ...current, ...part }));
  const { entries } = useResults(query, draft);
  const count = entries.length;

  const apply = () => void navigate(searchPath(withFilters(params, draft).toString()), { replace: true });

  return (
    <div className="flex flex-1 flex-col wide:mx-auto wide:w-list">
      <div className="flex items-center justify-between pt-3.5 pr-3 pl-5">
        <h1 className="m-0 font-display text-[26px] font-extrabold tracking-display">{copy.pages.filters}</h1>
        <Link
          replace
          to={searchPath(params.toString())}
          aria-label={copy.filters.close}
          className="flex size-11 items-center justify-center text-ink"
        >
          <CloseIcon size={22} />
        </Link>
      </div>

      <Section title={copy.filters.sortBy} className="pt-[18px]">
        <SortOptions value={draft.sort} onChange={(sort) => change({ sort })} />
      </Section>

      <div className="mt-5 px-gutter-phone">
        <OpenNowSwitch checked={draft.open} onChange={(open) => change({ open })} />
      </div>

      <Section title={copy.filters.distance} className="pt-5">
        <WithinOptions value={draft.withinKm} onChange={(withinKm) => change({ withinKm })} locale={locale} />
      </Section>

      <Section title={copy.filters.kinds} className="pt-[22px] pb-5">
        <KindOptions value={draft.families} onChange={(families) => change({ families })} />
      </Section>

      <div className="sticky bottom-0 mt-auto flex items-center gap-3 border-t-token border-line bg-ground px-gutter-phone pt-4 pb-[26px]">
        <button
          type="button"
          onClick={() => setDraft(noFilters())}
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
