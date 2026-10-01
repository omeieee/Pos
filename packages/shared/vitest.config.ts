import { defineConfig } from 'vitest/config';

// The seeded random-loop tests (cash and co-pay) run thousands of cases; on a busy machine (CI, a
// laptop running several packages at once) they can pass the 5 s default and fail for no reason.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
