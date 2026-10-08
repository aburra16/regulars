/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** MapTiler API key for map tiles and style. Unset (or empty) means no map. */
  readonly VITE_MAPTILER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
