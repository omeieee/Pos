/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** The LIFF app id (`1234567890-abcdefgh`) of the customer app's LINE Login channel. */
  readonly VITE_LIFF_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
