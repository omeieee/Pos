import { defineConfig } from 'vitest/config';

// The tests open real local sockets and render Thai tickets; allow for a busy machine.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
