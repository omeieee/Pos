import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../config.ts';
import { writeVapidFile } from './vapid-file.ts';

const dir = mkdtempSync(join(tmpdir(), 'sds-vapid-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('writeVapidFile', () => {
  test('writes three env lines that the config accepts, and returns only the public key', () => {
    const path = join(dir, 'keys.env');
    const result = writeVapidFile(path, 'mailto:owner@example.test', false);
    expect(result.path).toBe(path);
    const env = Object.fromEntries(
      readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    ) as Record<string, string>;
    expect(Object.keys(env)).toEqual(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
    expect(env.VAPID_PUBLIC_KEY).toBe(result.publicKey);
    expect(JSON.stringify(result)).not.toContain(env.VAPID_PRIVATE_KEY ?? 'x');
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      AUTH_SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
      ...env,
    });
    expect(config.vapid?.subject).toBe('mailto:owner@example.test');
  });

  test('refuses to replace an existing file unless forced', () => {
    const path = join(dir, 'twice.env');
    const first = writeVapidFile(path, 'mailto:owner@example.test', false);
    expect(() => writeVapidFile(path, 'mailto:owner@example.test', false)).toThrow(/EEXIST/);
    expect(readFileSync(path, 'utf8')).toContain(first.publicKey);
    const second = writeVapidFile(path, 'mailto:owner@example.test', true);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(existsSync(path)).toBe(true);
  });
});
