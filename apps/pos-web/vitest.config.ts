import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Kept apart from vite.config.ts so `vite build` never loads vitest. The first jsdom render in a
// file is slow when every package's tests run at once (turbo runs them in parallel on one laptop);
// alone it takes well under a second.
export default mergeConfig(viteConfig, defineConfig({ test: { testTimeout: 20_000 } }));
