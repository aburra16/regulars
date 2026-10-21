/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development only: comma-separated relays to read reviews from. Ignored in production builds. */
  readonly VITE_REVIEW_RELAYS?: string;
  /** Development only: comma-separated relays to read and save follow lists at, beside a person's own. Ignored in production builds. */
  readonly VITE_FOLLOW_LIST_RELAYS?: string;
  /** Development only: comma-separated relays to read and save saved places at, beside a person's own. Ignored in production builds. */
  readonly VITE_SAVED_LIST_RELAYS?: string;
  /** Development only: `<scorer hex>@<relay>`, used in place of the house's scorer. Ignored in production builds. */
  readonly VITE_DEV_SCORER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
