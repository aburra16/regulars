import { type JSX, type ReactNode, useState } from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { useOwnName } from "../account/useOwnName.ts";
import { copy } from "../copy/en.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { ThemeSwitch } from "../theme/ThemeSwitch.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { SavedSoon, SignedOutPrompt } from "./SignedOutPrompt.tsx";

/**
 * The person's own page, as far as M2b has one: their name over what is theirs to do here, which is
 * to sign out, and the page's settings (dark mode). `name` is undefined until it is known: "You".
 */
function YouFrame({ name, children }: { name: string | undefined; children?: ReactNode }): JSX.Element {
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
    </div>
  );
}

/** You, for the person signed in as `pubkey`: their name, from their profile, and Sign out. */
function Yours({ pubkey, onSignOut }: { pubkey: string; onSignOut(): void }): JSX.Element {
  const name = useOwnName(pubkey);
  return (
    <YouFrame name={name}>
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
 * The You tab and the account button's page. Signed in: the person's name and Sign out. While a
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

/**
 * Saved. Before sign in, the prompt to sign in. After, saving places is not open yet (M2b), and the
 * page says so, with no way to sign in again.
 */
export function SavedPage(): JSX.Element {
  const { account, restoring } = useAccount();
  return account === undefined && !restoring ? <SignedOutPrompt page="saved" /> : <SavedSoon />;
}
