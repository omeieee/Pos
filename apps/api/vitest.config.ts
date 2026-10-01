import { defineConfig } from 'vitest/config';

// Many tests hash with scrypt and start an in-memory Postgres; on a busy machine (CI, a laptop
// running several packages at once) a fast test can pass the 5 s default and fail for no reason.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
