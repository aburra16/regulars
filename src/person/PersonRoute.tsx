import { type JSX, useContext, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { useNames } from "../score/useScore.ts";
import { HeadingIn } from "../shell/headingFocus.ts";
import { NotFound, PageError } from "../shell/PageError.tsx";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { PageMessage } from "../ui/Banner.tsx";
import { fetchedPersonPage, loadPersonPage } from "./loadPersonPage.ts";
import { fromNpub } from "./npub.ts";

/** The page's code: fetched, being fetched, or not to be had this time. */
type Step = { code: NonNullable<ReturnType<typeof fetchedPersonPage>> } | "fetching" | "failed";

/**
 * The page of the person with the key `pubkey`, once its code is there. The code is a chunk of its
 * own (./loadPersonPage.ts), fetched when a person's page is first opened in the tab: meanwhile the
 * loading line, and the page that says something went wrong if it cannot be fetched, which the next
 * visit tries again. The tab is named for the person from the start, by the name their profile gives.
 *
 * A page that comes in after its code was fetched has its heading late: the shell is told once it is
 * in (`HeadingIn`), and gives it the focus it was due as the person arrived, as on any other page.
 */
function Fetched({ pubkey }: { pubkey: string }): JSX.Element {
  const name = useNames(useMemo(() => [pubkey], [pubkey])).get(pubkey) ?? copy.reviews.someone;
  useDocumentTitle(copy.titles.person(name));
  const [step, setStep] = useState<Step>(() => {
    const code = fetchedPersonPage();
    return code === undefined ? "fetching" : { code };
  });

  useEffect(() => {
    if (step !== "fetching") return;
    let gone = false;
    loadPersonPage().then(
      (code) => {
        if (!gone) setStep({ code });
      },
      () => {
        if (!gone) setStep("failed");
      },
    );
    return () => {
      gone = true;
    };
  }, [step]);

  // The page is in, and its heading with it. Nothing when the heading was there as the person arrived.
  const headingIn = useContext(HeadingIn);
  const drawn = typeof step === "object";
  useEffect(() => {
    if (drawn) headingIn?.();
  }, [drawn, headingIn]);

  if (step === "failed") return <PageError />;
  if (step === "fetching") return <PageMessage>{copy.person.loading}</PageMessage>;
  const { PersonPage } = step.code;
  return <PersonPage pubkey={pubkey} name={name} />;
}

/**
 * The route of a person's page, `/person/<npub>`: the person is named in the address by their public
 * key as other apps write it for people to pass around (./npub.ts). An address that names nobody (a
 * code of another kind, one cut short or mistyped, a key in hex) has no page: the not-found page, and
 * nothing is fetched. The page itself is not in the app's first code (`Fetched`); this is, and is small.
 */
export function PersonRoute(): JSX.Element {
  const { npub = "" } = useParams();
  const pubkey = useMemo(() => fromNpub(npub), [npub]);
  if (pubkey === null) return <NotFound />;
  // Each person's page is a page of its own: nothing drawn for one is kept for the next.
  return <Fetched key={pubkey} pubkey={pubkey} />;
}
