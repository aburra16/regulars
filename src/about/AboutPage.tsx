import { type JSX, type ReactNode, useMemo } from "react";

import { copy } from "../copy/en.ts";
import { usePlaces } from "../places/store.tsx";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useWide } from "../shell/useWide.ts";
import { BackLink } from "../ui/BackLink.tsx";
import { HouseName } from "../ui/HouseName.tsx";
import { NewTabHint } from "../ui/NewTab.tsx";
import { HOW_SCORES_WORK, SIGNING_IN } from "./anchors.ts";
import { aboutFigures, formatCount, formatRefreshed } from "./figures.ts";
import { NOTICES_FILE } from "./notices.ts";

/** Where OpenStreetMap says how its data may be used. */
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

/** A paragraph of the page's words. */
const BODY = "m-0 max-w-measure text-body leading-[1.5] text-ink-soft";

/**
 * A section of the page: a heading and its words. `id` is where a link to the section goes
 * (About.dc.html has none; the anchors are the app's), and names the section for a screen reader
 * by its heading.
 */
function Section({
  id,
  heading,
  wide,
  children,
}: {
  id: string;
  heading: string;
  wide: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className={`m-0 font-display font-bold ${wide ? "text-[26px]" : "text-h2"}`}>
        {heading}
      </h2>
      {children}
    </section>
  );
}

/** The figures of the places the app has, in a grey panel: a dash for each until the places are loaded. */
function Figures({ locale }: { locale: string }): JSX.Element {
  const { places } = usePlaces();
  const figures = useMemo(() => (places.length === 0 ? undefined : aboutFigures(places)), [places]);
  const { none } = copy.about.figures;
  const rows: [label: string, value: string][] = [
    [copy.about.figures.places, figures === undefined ? none : formatCount(figures.places, locale)],
    [copy.about.figures.countries, figures === undefined ? none : formatCount(figures.countries, locale)],
    [
      copy.about.figures.lastRefreshed,
      figures?.refreshedAt === undefined ? none : formatRefreshed(figures.refreshedAt, locale),
    ],
    [copy.about.figures.refreshed, copy.about.figures.monthly],
  ];
  return (
    <dl className="m-0 flex flex-col rounded-[18px] bg-surface px-4 py-1 text-[15px]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b-token border-line py-3 last:border-b-0">
          <dt className="text-muted">{label}</dt>
          <dd className="m-0 text-right font-bold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A link of the fine print, to a page outside the app, in a new tab. */
function FineLink({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-touch items-center self-start text-[15px] font-bold text-ink underline hover:text-accent"
    >
      {children}
      <NewTabHint />
    </a>
  );
}

/**
 * The fine print under the figures: where the details come from, the licence, and a link to its
 * terms; then the licences of the software the site is built from, a file at the root of the site.
 */
function FinePrint(): JSX.Element {
  return (
    <>
      <p className="m-0 max-w-measure text-caption leading-[1.5] text-muted">{copy.about.source}</p>
      <p className="m-0 max-w-measure text-secondary leading-[1.5] text-muted">{copy.about.licence}</p>
      <div className="flex flex-col">
        <FineLink href={OSM_COPYRIGHT}>{copy.about.licenceLink}</FineLink>
        <FineLink href={`/${NOTICES_FILE}`}>{copy.about.softwareLicences}</FineLink>
      </div>
    </>
  );
}

/**
 * The dark card at the foot of the phone's page, and in the desktop's rail. Its words are in the
 * sign-in page's colour on the dark (--on-night-soft), so it keeps the light theme's colours in both.
 */
function Yours(): JSX.Element {
  return (
    <section data-theme="light" className="flex flex-col gap-2 rounded-panel bg-ink p-[18px]">
      <div className="text-[17px] font-bold text-ground">{copy.about.yoursHeading}</div>
      <div className="text-[15px] leading-[1.5] text-on-night-soft">{copy.about.yoursBody}</div>
    </section>
  );
}

/** The sections that are words only, in the order of the design, for both layouts. */
function Words({ wide }: { wide: boolean }): JSX.Element {
  return (
    <>
      <Section id={HOW_SCORES_WORK} heading={copy.about.reviewsHeading} wide={wide}>
        <p className={BODY}>{copy.about.reviewsBody}</p>
        <p className={BODY}>{copy.about.viewsBody}</p>
      </Section>
      <Section id="who-the-house-is" heading={copy.about.houseHeading} wide={wide}>
        <p className={BODY}>
          <HouseName text={copy.about.houseBody} size="body" />
        </p>
      </Section>
      <Section id={SIGNING_IN} heading={copy.about.signingInHeading} wide={wide}>
        <p className={BODY}>{copy.about.signingInBody}</p>
      </Section>
    </>
  );
}

/** The phone's page (About.dc.html): one column, the figures inside the first section, the dark card at the foot. */
function PhoneAbout({ locale }: { locale: string }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col pb-8">
      <div className="px-3 pt-3.5">
        <BackLink wide={false} back={copy.about.back} />
      </div>
      <header className="flex flex-col gap-3 px-gutter-phone pt-2">
        <div className="font-display text-[20px] font-extrabold tracking-[-0.01em] text-accent">{copy.app.name}</div>
        <h1 className="m-0 font-display text-display-phone leading-[1.08] font-extrabold tracking-display">
          {copy.about.title}
        </h1>
      </header>
      <div className="flex flex-col gap-[22px] px-gutter-phone pt-7">
        <Section id="where-the-places-come-from" heading={copy.about.placesHeading} wide={false}>
          <p className={BODY}>{copy.about.placesBody}</p>
          <Figures locale={locale} />
          <FinePrint />
        </Section>
        <Words wide={false} />
        {/* Questions go to an address Avi has not given yet: when he does, it goes here as a last line. */}
        <div className="pt-1">
          <Yours />
        </div>
      </div>
    </div>
  );
}

/**
 * The desktop's page, in the pattern of DeskPlace.dc.html (About is not drawn for a desktop): the way
 * back, then a column of the words and a rail 320 px wide with the figures and the dark card.
 */
function DeskAbout({ locale }: { locale: string }): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide back={copy.about.back} />
      <div className="flex items-start gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <h1 className="m-0 font-display text-[48px] leading-[1.04] font-extrabold tracking-[-0.025em]">{copy.about.title}</h1>
          <Section id="where-the-places-come-from" heading={copy.about.placesHeading} wide>
            <p className={BODY}>{copy.about.placesBody}</p>
            <FinePrint />
          </Section>
          <Words wide />
        </div>
        <aside aria-label={copy.about.railLabel} className="flex w-rail min-w-0 shrink-0 flex-col gap-4 pt-2">
          <Figures locale={locale} />
          <Yours />
        </aside>
      </div>
    </div>
  );
}

/**
 * About and data (screen 15), at `/about`: where the places come from, with figures worked out from
 * the places the app has, and where the reviews come from, who the house is and how signing in works.
 * It does not wait for the places: its words are there at once, the figures when the places are, which
 * keeps a link to one of its sections (`#how-scores-work`, `#signing-in`) landing on it.
 */
export function AboutPage(): JSX.Element {
  useDocumentTitle(copy.titles.about);
  const wide = useWide();
  const locale = useLocale();
  return wide ? <DeskAbout locale={locale} /> : <PhoneAbout locale={locale} />;
}
