// PostToolUse hook (Edit|Write|MultiEdit): formats the edited file with Biome, then
// typechecks only the workspace package that contains it. Type errors go back to Claude.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = input.tool_input?.file_path;
if (!filePath || !existsSync(filePath)) process.exit(0);

// biome-ignore lint/suspicious/noUndeclaredEnvVars: set by Claude Code for hooks, not a turbo task input.
const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
const run = (args, cwd) =>
  spawnSync('pnpm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

if (/\.(ts|tsx|js|mjs|cjs|jsx|json|jsonc|css)$/.test(filePath)) {
  run(['exec', 'biome', 'check', '--write', '--no-errors-on-unmatched', filePath], root);
}

if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0);

let dir = dirname(resolve(filePath));
while (dir.startsWith(root) && dir !== root) {
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
    if (!scripts.typecheck) process.exit(0);
    const result = run(['run', 'typecheck'], dir);
    if (result.status !== 0) {
      console.error(`Typecheck failed in ${dir}:\n${result.stdout}${result.stderr}`);
      process.exit(2);
    }
    process.exit(0);
  }
  dir = dirname(dir);
}
