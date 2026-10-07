/**
 * Every string a person can read lives in this file. tests/copy.test.ts fails on
 * protocol vocabulary anywhere in it (nostr, relay, key, sign ...), apart from these
 * two strings, which are allowed only when they are a whole string on their own.
 * "Sign in" is the app's word for authenticating; "signed in" and "signed out" are
 * not allowed, so write "after you sign in".
 */
export const ALLOWED_PROTOCOL_STRINGS = {
  signInButton: "Continue with Nostr",
  bitcoinChip: "Bitcoin accepted",
} as const;

/** A leaf is a string, or a template function that returns one. Groups nest freely. */
type CopyNode = string | ((...args: never[]) => string) | { readonly [key: string]: CopyNode };

export const copy = {
  app: {
    name: "Regulars",
  },
  meta: {
    description: "Restaurant ratings from people you'd actually ask.",
  },
  signin: {
    continueButton: ALLOWED_PROTOCOL_STRINGS.signInButton,
  },
  place: {
    bitcoinChip: ALLOWED_PROTOCOL_STRINGS.bitcoinChip,
  },
} satisfies { readonly [key: string]: CopyNode };
