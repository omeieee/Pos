import { describe, expect, it } from 'vitest';
import { loadConfig, requireApi } from './config.ts';
import { buildEnvFileContent } from './setup.ts';

describe('buildEnvFileContent', () => {
  it('writes a valid .env that loadConfig and requireApi accept', () => {
    const text = buildEnvFileContent({
      apiBaseUrl: 'https://161-118-211-42.sslip.io',
      deviceToken: 'sds_dev_0123456789abcdef0123456789',
      printerHost: 'usb',
    });
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    const config = loadConfig(env);
    expect(requireApi(config)).toEqual({
      baseUrl: 'https://161-118-211-42.sslip.io',
      token: 'sds_dev_0123456789abcdef0123456789',
    });
    expect(config.printer).toMatchObject({
      host: 'usb',
      usbPath: 'auto',
      widthDots: 576,
    });
  });
});
