import { describe, expect, test } from 'vitest';
import { emailArg, multipleOwnersMessage } from './common.ts';

describe('emailArg', () => {
  test('reads --email in both spellings and is undefined when absent', () => {
    expect(emailArg(['--email', 'a@example.test'])).toBe('a@example.test');
    expect(emailArg(['--email=b@example.test'])).toBe('b@example.test');
    expect(emailArg(['--other', 'x', '--email', 'c@example.test'])).toBe('c@example.test');
    expect(emailArg([])).toBeUndefined();
    expect(emailArg(['--other', 'x'])).toBeUndefined();
  });
});

describe('multipleOwnersMessage', () => {
  test('gives the count and the flag, no address', () => {
    const message = multipleOwnersMessage(3);
    expect(message).toContain('3 owners');
    expect(message).toContain('--email');
    expect(message).not.toContain('@');
  });
});
