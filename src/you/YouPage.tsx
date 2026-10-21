import { type JSX, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { useOwnName } from "../account/useOwnName.ts";
import { copy } from "../copy/en.ts";
import { usePutBack } from "../follow/keptStore.ts";
import { fetchedKeptCopies, loadKeptCopies } from "../follow/loadKeptCopies.ts";
import { personPath } from "../person/npub.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { ThemeSwitch } from "../theme/ThemeSwitch.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { SignedOutPrompt } from "./SignedOutPrompt.tsx";

/**
 * The person's own page, as far as M2b has one: their name over what is theirs to do here, which is
 * to open the page others see of them and to sign out, and the page's settings (dark mode). `name`
 * is undefined until it is known: "You". `last` is drawn under the settings, at the foot of the
 * page: what comes late, or is not always there, moves nothing above it.
 */
function YouFrame({ name, children, last }: { name: string | undefined; children?: ReactNode; last?: ReactNode }): JSX.Element {
  useDocumentTitle(copy.titles.you);
  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-6 px-gutter-phone pt-10 pb-8 wide:px-gutter-desktop wide:pt-14">
      <h1
        tabIndex={-1}
        className="m-0 font-display text-display-phone font-extrabold tracking-display wrap-break-word outline-none wide:text-display-desktop"
      >
        {name === undefined ? copy.nav.you : <bdi lang={scriptLang(name)}>{name}</bdi>}
      </h1>
      {children}
      <ThemeSwitch />
      {last}
    </div>
  );
}

/**
 * The copies kept of who the person follows, one before each change they made in this browser, with
 * the way to put one back (src/follow/KeptCopies.tsx): for the person signed in as `pubkey`, once
 * they have a copy, and nothing at all until then. Whether they have one is the session's to say
 * (`usePutBack`), which reads the device's storage for them, and for nobody while Follow is not open.
 * The section's code is a chunk of its own, fetched when there is first a copy to show
 * (src/follow/loadKeptCopies.ts): nothing is drawn while it comes, nor if it cannot be fetched, which
 * the next visit tries again.
 */
function YourCopies({ pubkey }: { pubkey: string }): JSX.Element | null {
  const has = usePutBack(pubkey).copies.length > 0;
  const [code, setCode] = useState(fetchedKeptCopies);

  useEffect(() => {
    if (!has || code !== undefined) return;
    let gone = false;
    loadKeptCopies().then(
      (fetched) => {
        if (!gone) setCode(fetched);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [has, code]);

  if (!has || code === undefined) return null;
  const { KeptCopies } = code;
  return <KeptCopies pubkey={pubkey} />;
}

/**
 * You, for the person signed in as `pubkey`: their name, from their profile; the link to their own
 * page, which lists their reviews as anyone sees them (src/person/PersonPage.tsx); Sign out; and,
 * at the foot of the page, the copies kept of who they follow, when there are any (`YourCopies`).
 * Those are each person's own: nothing drawn or asked about for one person is kept for the next.
 */
function Yours({ pubkey, onSignOut }: { pubkey: string; onSignOut(): void }): JSX.Element {
  const name = useOwnName(pubkey);
  return (
    <YouFrame name={name} last={<YourCopies key={pubkey} pubkey={pubkey} />}>
      <Link
        to={personPath(pubkey)}
        className="inline-flex min-h-touch items-center self-start text-body font-bold text-ink underline hover:text-accent"
      >
        {copy.you.yourReviews}
      </Link>
      <button
        type="button"
        onClick={onSignOut}
        className="inline-flex h-13 cursor-pointer items-center justify-center self-start rounded-button border-token border-field-border bg-transparent px-7 font-text text-body font-bold text-ink"
      >
        {copy.you.signOut}
      </button>
    </YouFrame>
  );
}

/**
 * The You tab and the account button's page. Signed in: the person's name, the link to their own page, Sign out, and the copies kept of who they follow. While a
 * session this tab kept is restored, the same page without them yet, rather than a flash of the
 * sign-in prompt. Otherwise the prompt to sign in, which has the focus when the person has just
 * signed out here, as the button they pressed is gone.
 */
export function YouPage(): JSX.Element {
  const { account, restoring, signOut } = useAccount();
  const [signedOutHere, setSignedOutHere] = useState(false);
  if (account !== undefined) {
    return (
      <Yours
        pubkey={account.pubkey}
        onSignOut={() => {
          setSignedOutHere(true);
          signOut();
        }}
      />
    );
  }
  if (restoring) return <YouFrame name={undefined} />;
  return <SignedOutPrompt page="you" focusHeading={signedOutHere} />;
}
