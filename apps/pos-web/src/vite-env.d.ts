/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** '1' in `pnpm dev` answers /v1/auth from the made-up mock server. Never set in builds. */
  readonly VITE_MOCK_API?: string;
  /** The public web address of the app, for links people open elsewhere (invite links). Default: the page's own origin. */
  readonly VITE_APP_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
