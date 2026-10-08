import { createContext } from "react";

/**
 * What signing out lets go of, beside the session: what is held for the person by the providers
 * around the account provider, such as the reviews they posted that the tab holds until the relays
 * send them back (src/score/ScoresProvider.tsx gives it). Nothing, where no provider gives it. The
 * account provider calls it at Sign out, and when the person's signer signs as someone else.
 */
export const ForgetOnSignOut = createContext<() => void>(() => {});
