import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { pwaOptions } from './pwa-options.ts';

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
  build: { outDir: 'dist' },
  // The first jsdom render in a file is slow when the whole workspace's tests run at once
  // (turbo runs every package in parallel on one laptop); alone it takes well under a second.
  test: { testTimeout: 20_000 },
});
