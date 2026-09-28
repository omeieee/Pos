// PreToolUse hook (Edit|Write|MultiEdit): blocks edits to applied migrations and .env files.
// Migrations are forward-only (CLAUDE.md conventions); secrets never go through Claude (rule 10).
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = String(input.tool_input?.file_path ?? '').replaceAll('\\', '/');
const name = basename(filePath);

if (/^\.env/.test(name) && name !== '.env.example') {
  console.error(
    `Blocked: ${name} may hold secrets. Edit it yourself; only .env.example is editable.`,
  );
  process.exit(2);
}

// New migrations come from `pnpm --filter @sds/db db:generate`; existing ones are never edited.
if (/\/packages\/db\/migrations\/[^/]+\.sql$/.test(filePath) && existsSync(filePath)) {
  console.error(
    `Blocked: ${name} is an existing migration (forward-only). Add a new migration instead.`,
  );
  process.exit(2);
}
