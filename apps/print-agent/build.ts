/**
 * Bundles the print agent into dist/agent.mjs with every dependency (and the Thai font) inlined,
 * so the notebook needs only Node.js and this one file.
 *   node build.ts
 */
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const outdir = 'dist';
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

if (process.platform === 'win32') {
  const { existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (existsSync(csc) && existsSync('windows\\SaapDonSenPrintAgent.cs')) {
    try {
      execFileSync(
        csc,
        [
          '/nologo',
          '/target:winexe',
          `/out:${outdir}\\SaapDonSenPrintAgent.exe`,
          '/reference:System.Windows.Forms.dll',
          'windows\\SaapDonSenPrintAgent.cs',
        ],
        { stdio: 'inherit' },
      );
    } catch {
      // If SaapDonSenPrintAgent.exe is currently running, Windows locks the .exe file; keep the existing one.
    }
  }
}
