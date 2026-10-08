/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** MapTiler API key for map tiles and style. Unset (or empty) means no map. */
  readonly VITE_MAPTILER_KEY?: string;
  /** Development only: comma-separated relays to read reviews from. Ignored in production builds. */
  readonly VITE_REVIEW_RELAYS?: string;
  /** Development only: `<scorer hex>@<relay>`, used in place of the house's scorer. Ignored in production builds. */
  readonly VITE_DEV_SCORER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
