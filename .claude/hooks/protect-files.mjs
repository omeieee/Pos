// PreToolUse hook (Edit|Write|MultiEdit): blocks edits to applied migrations and .env files.
// Migrations are forward-only (CLAUDE.md conventions); secrets never go through Claude (rule 10).
// Fails closed: any error blocks the edit (exit 2) instead of silently allowing it.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const raw = String(input.tool_input?.file_path ?? '');
  const filePath = resolve(input.cwd ?? process.cwd(), raw).replaceAll('\\', '/');
  const name = basename(filePath);

  if (/^\.env/.test(name) && name !== '.env.example') {
    console.error(
      `Blocked: ${name} may hold secrets. Edit it yourself; only .env.example is editable.`,
    );
    process.exit(2);
  }

  // New migrations come from `pnpm --filter @sds/db db:generate`; existing ones, and the
  // drizzle-kit journal/snapshots in meta/, are never edited by hand. An empty file is a fresh
  // `drizzle-kit generate --custom` migration and may be filled in once.
  if (
    /\/packages\/db\/migrations\/.+/.test(filePath) &&
    existsSync(filePath) &&
    readFileSync(filePath, 'utf8')
      .replace(/^\s*--.*$/gm, '')
      .trim() !== ''
  ) {
    console.error(
      `Blocked: ${name} is an existing migration file (forward-only). Add a new migration instead.`,
    );
    process.exit(2);
  }
} catch (error) {
  console.error(`protect-files hook failed, blocking to be safe: ${error}`);
  process.exit(2);
}
