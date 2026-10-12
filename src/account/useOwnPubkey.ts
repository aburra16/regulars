import { useState } from "react";

import { useAccount } from "./AccountProvider.tsx";
import { readSession } from "./session.ts";

/**
 * The public key of the person signed in, for what the pages show as theirs (their own review, on its
 * own; never counted among "others": ruling R15, R16). While a session this tab kept is restored, the
 * kept session's, so that what is theirs does not move once they are signed in; undefined when
 * nobody is, or is about to be.
 */
export function useOwnPubkey(): string | undefined {
  const { account, restoring } = useAccount();
  const [kept] = useState(() => readSession()?.pubkey);
  return account?.pubkey ?? (restoring ? kept : undefined);
}
