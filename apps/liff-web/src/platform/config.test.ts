import { describe, expect, test } from 'vitest';
import { joinUrl } from './config.ts';

describe('joinUrl', () => {
  test('puts exactly one slash between base and path', () => {
    expect(joinUrl('https://api.example.com', '/healthz')).toBe('https://api.example.com/healthz');
    expect(joinUrl('https://api.example.com/', 'healthz')).toBe('https://api.example.com/healthz');
    expect(joinUrl('https://api.example.com//', '//healthz')).toBe(
      'https://api.example.com/healthz',
    );
  });
});
