/**
 * Bundles the API into dist/ (server.js, migrate.js, owner-create.js, owner-reset.js, owner-unlock.js) with every dependency inlined, so the
 * runtime image needs only dist/. Workspace packages are TypeScript source; esbuild compiles them.
 *   node build.ts          one-off build
 *   node build.ts --watch  rebuild on change and restart the server (reads apps/api/.env if present)
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type BuildOptions, build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const options: BuildOptions = {
  entryPoints: {
    server: 'src/server.ts',
    migrate: 'src/migrate.ts',
    'owner-create': 'src/cli/owner-create.ts',
    'owner-reset': 'src/cli/owner-reset.ts',
    'owner-unlock': 'src/cli/owner-unlock.ts',
    'richmenu-upload': 'src/cli/richmenu-upload.ts',
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  // Bundled CommonJS dependencies call require(); give the ESM output one.
  banner: {
    js: "import { createRequire as __sdsCreateRequire } from 'node:module'; const require = __sdsCreateRequire(import.meta.url);",
  },
};

// dist/ is ESM regardless of where it is copied; migrations ship next to migrate.js.
writeFileSync(`${outdir}/package.json`, `${JSON.stringify({ type: 'module' })}\n`);
cpSync('../../packages/db/migrations', `${outdir}/migrations`, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.rebuild(); // dist/server.js must exist before node --watch starts
  await ctx.watch();
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', `${outdir}/server.js`], {
    stdio: 'inherit',
  });
} else {
  await build(options);
}
