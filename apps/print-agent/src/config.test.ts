import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireApi } from './config.ts';

const TOKEN = 'a-long-enough-device-token-123';

describe('loadConfig', () => {
  it('needs only the printer host and fills in defaults', () => {
    const config = loadConfig({ PRINTER_HOST: '192.168.1.50' });
    expect(config.printer).toEqual({
      host: '192.168.1.50',
      port: 9100,
      usbPath: null,
      widthDots: 576,
      timeoutMs: 12_000,
      statusCheck: false,
    });
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.apiBaseUrl).toBeNull();
    expect(() => requireApi(config)).toThrow(ConfigError);
  });

  it('supports USB mode via PRINTER_HOST=usb or PRINTER_USB_PATH', () => {
    const autoUsb = loadConfig({ PRINTER_HOST: 'usb' });
    expect(autoUsb.printer).toMatchObject({ host: 'usb', usbPath: 'auto' });

    const explicitUsb = loadConfig({
      PRINTER_USB_PATH:
        '\\\\?\\usb#vid_1fc9&pid_2016#5d720f6e3157#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}',
    });
    expect(explicitUsb.printer).toMatchObject({
      host: 'usb',
      usbPath: '\\\\?\\usb#vid_1fc9&pid_2016#5d720f6e3157#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}',
    });
  });

  it('reads the API settings and trims a trailing slash', () => {
    const config = loadConfig({
      PRINTER_HOST: 'p',
      PRINT_API_URL: 'https://pos.example.com/',
      PRINT_DEVICE_TOKEN: TOKEN,
      PRINTER_WIDTH_DOTS: '512',
      PRINTER_STATUS_CHECK: 'true',
    });
    expect(requireApi(config)).toEqual({ baseUrl: 'https://pos.example.com', token: TOKEN });
    expect(config.printer.widthDots).toBe(512);
    expect(config.printer.statusCheck).toBe(true);
  });

  it('treats an empty variable as not set', () => {
    expect(loadConfig({ PRINTER_HOST: 'p', PRINTER_PORT: '' }).printer.port).toBe(9100);
  });

  it('allows plain http only for localhost', () => {
    expect(() =>
      loadConfig({ PRINTER_HOST: 'p', PRINT_API_URL: 'http://pos.example.com' }),
    ).toThrow(ConfigError);
    expect(
      loadConfig({ PRINTER_HOST: 'p', PRINT_API_URL: 'http://localhost:3000' }).apiBaseUrl,
    ).toBe('http://localhost:3000');
  });

  it('rejects a bad width and names the variable but never its value', () => {
    try {
      loadConfig({ PRINTER_HOST: 'p', PRINTER_WIDTH_DOTS: '500', PRINT_DEVICE_TOKEN: 'short' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain('PRINTER_WIDTH_DOTS');
      expect(message).toContain('PRINT_DEVICE_TOKEN');
      expect(message).not.toContain('short');
    }
  });

  it('requires the printer host', () => {
    expect(() => loadConfig({})).toThrow(/PRINTER_HOST/);
  });
});
