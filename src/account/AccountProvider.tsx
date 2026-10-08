import type { NostrSigner } from "@nostrify/nostrify";
import { createContext, type JSX, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { RelayFor } from "./connect.ts";
import { type Account, forgetSession, readSession } from "./session.ts";

export type { Account, How } from "./session.ts";

/** Who is signed in, for every page below the provider. */
export interface AccountState {
  /** The person, once signed in; undefined before, and while a session kept by this tab is restored. */
  account: Account | undefined;
  /** Forgets the session in this tab, and closes what its signer holds open. */
  signOut(): void;
  /** Whether a session this tab kept is being restored: the person is about to be signed in. */
  restoring: boolean;
}

/** The ways to sign in, for the sign-in page. Each resolves once the person is signed in, and rejects as `connect.ts` does. */
export interface Connect {
  browser(signal: AbortSignal): Promise<void>;
  phone(onLink: (uri: string) => void, signal: AbortSignal): Promise<void>;
  bunker(uri: string, signal: AbortSignal): Promise<void>;
}

const AccountContext = createContext<{ state: AccountState; connect: Connect } | null>(null);

/** Nobody is signed in: what a tree with no provider has, such as a test of part of the app. */
const SIGNED_OUT: AccountState = { account: undefined, signOut: () => {}, restoring: false };

let connectCode: Promise<typeof import("./connect.ts")> | undefined;

/**
 * The signing code (./connect.ts), which brings Nostrify: loaded when it is first needed, as the relay
 * code is (src/score/store.ts), and once. A load that fails is tried again next time.
 */
function loadConnect(): Promise<typeof import("./connect.ts")> {
  connectCode ??= import("./connect.ts").catch((error: unknown) => {
    connectCode = undefined;
    throw error;
  });
  return connectCode;
}

/**
 * `account`, with a signer that checks each event it signs is the person's. An add-on or a phone app
 * may have changed to someone else since the person signed in (a reload does not ask again); then
 * `signedSomeoneElse` signs them out, and the signing fails, so they are asked to sign in again.
 */
function checked(account: Account, signedSomeoneElse: () => void): Account {
  const { pubkey, signer } = account;
  const guarded: NostrSigner = {
    getPublicKey: async () => pubkey,
    async signEvent(template) {
      const event = await signer.signEvent(template);
      if (event.pubkey !== pubkey) {
        signedSomeoneElse();
        throw new Error("The signer signed as someone other than the person who signed in");
      }
      return event;
    },
  };
  if (signer.getRelays !== undefined) guarded.getRelays = () => signer.getRelays!();
  return { pubkey, how: account.how, signer: guarded };
}

/**
 * Holds who is signed in, for the pages below it (`useAccount`), and the ways to sign in, for the
 * sign-in page (`useConnect`). A session this tab kept (`sessionStorage`) is restored on mount,
 * asking the person nothing. `relays` gives the NIP-46 meeting point at an address, and is read once,
 * on mount; without it, the app's own, which opens a socket when a phone app is first asked.
 */
export function AccountProvider({ children, relays }: { children: ReactNode; relays?: RelayFor }): JSX.Element {
  const [relaysAt] = useState(() => relays);
  const [shown, setShown] = useState<{ account: Account | undefined; restoring: boolean }>(() => ({
    account: undefined,
    restoring: readSession() !== null,
  }));
  // The account as the signing code gave it, whose signer is the one to close.
  const current = useRef<Account | undefined>(undefined);

  const signOut = useCallback(() => {
    const was = current.current;
    current.current = undefined;
    forgetSession();
    setShown({ account: undefined, restoring: false });
    if (was !== undefined) void loadConnect().then((code) => code.disconnect(was));
  }, []);

  const adopt = useCallback(
    (account: Account) => {
      const was = current.current;
      if (was !== undefined && was !== account) void loadConnect().then((code) => code.disconnect(was));
      current.current = account;
      setShown({
        account: checked(account, () => {
          if (current.current === account) signOut();
        }),
        restoring: false,
      });
    },
    [signOut],
  );

  useEffect(() => {
    const session = readSession();
    if (session === null) {
      setShown((now) => (now.restoring ? { account: undefined, restoring: false } : now));
      return;
    }
    let live = true;
    loadConnect().then(
      (code) => {
        // The person may have signed in some other way while the code loaded.
        if (live && current.current === undefined) adopt(code.restoreAccount(session, relaysAt));
      },
      () => {
        // The code could not be loaded: the person is not signed in on this page, and can sign in again.
        if (live) setShown((now) => (now.restoring ? { account: undefined, restoring: false } : now));
      },
    );
    return () => {
      live = false;
    };
  }, [adopt, relaysAt]);

  const connect = useMemo<Connect>(
    () => ({
      browser: async (signal) => adopt(await (await loadConnect()).connectBrowser(signal)),
      phone: async (onLink, signal) => adopt(await (await loadConnect()).connectPhone({ onLink, signal, relays: relaysAt })),
      bunker: async (uri, signal) => adopt(await (await loadConnect()).connectBunker(uri, signal, relaysAt)),
    }),
    [adopt, relaysAt],
  );

  const value = useMemo(
    () => ({ state: { account: shown.account, restoring: shown.restoring, signOut }, connect }),
    [shown, signOut, connect],
  );
  return <AccountContext value={value}>{children}</AccountContext>;
}

/** Who is signed in. Outside an `AccountProvider`, nobody is. */
export function useAccount(): AccountState {
  return useContext(AccountContext)?.state ?? SIGNED_OUT;
}

/** The ways to sign in, for the sign-in page. Use it inside an `AccountProvider`. */
export function useConnect(): Connect {
  const value = useContext(AccountContext);
  if (value === null) throw new Error("useConnect must be used inside <AccountProvider>.");
  return value.connect;
}
