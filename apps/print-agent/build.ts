/**
 * Bundles the print agent into dist/agent.mjs with every dependency (and the Thai font) inlined,
 * so the notebook needs only Node.js and this one file.
 *   node build.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: { agent: 'src/main.ts' },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  // Bundled CommonJS dependencies (fontkit) call require(); give the ESM output one.
  banner: {
    js: "import { createRequire as __sdsCreateRequire } from 'node:module'; const require = __sdsCreateRequire(import.meta.url);",
  },
});
