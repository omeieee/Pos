import { defineConfig } from 'vitest/config';

// Drawing a Thai ticket takes a moment; allow for a busy machine running every package at once.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
