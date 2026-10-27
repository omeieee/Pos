/**
 * Settings of the print agent, read from environment variables (a `.env` file next to the
 * program works through `node --env-file=.env`). See `.env.example`.
 */
import { SUPPORTED_WIDTHS } from '@sds/escpos';
import { z } from 'zod';

export interface AgentConfig {
  /** Base address of the POS API, without `/v1`. Needed to run, not for `--test-print`. */
  apiBaseUrl: string | null;
  /** The `x-device-token` of this notebook's `print_agent` device. Never logged. */
  deviceToken: string | null;
  printer: {
    host: string;
    port: number;
    /** USB mode: `'auto'` (first connected USB printer) or a specific device path (`\\?\usb#...`), or `null` for LAN TCP. */
    usbPath: string | null;
    widthDots: (typeof SUPPORTED_WIDTHS)[number];
    /** Covers connecting and sending one ticket. */
    timeoutMs: number;
    /** Ask the printer for paper-out / cover-open before printing (off until checked on the device). */
    statusCheck: boolean;
  };
  pollIntervalMs: number;
  httpTimeoutMs: number;
  /** Where printed job ids are remembered. */
  printedFile: string;
  /** After Ctrl+C, how long to wait for the job in hand before giving up. */
  stopGraceMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isLocalHost = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  PRINT_API_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url));
    }, 'must be https (http only for localhost)')
    .optional(),
  PRINT_DEVICE_TOKEN: z.string().min(16).optional(),
  PRINTER_HOST: z.string().min(1).optional(),
  PRINTER_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  PRINTER_USB_PATH: z.string().min(1).optional(),
  PRINTER_WIDTH_DOTS: z.coerce
    .number()
    .refine((value): value is (typeof SUPPORTED_WIDTHS)[number] =>
      (SUPPORTED_WIDTHS as readonly number[]).includes(value),
    )
    .default(576),
  PRINTER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(25_000).default(12_000),
  PRINTER_STATUS_CHECK: flag.default(false),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  PRINTED_JOBS_FILE: z.string().min(1).default('printed-jobs.json'),
  STOP_GRACE_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
});

/** Reads the settings; an empty variable counts as not set. */
export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    // Only the names of the bad variables: a value may be the token.
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '?')))];
    throw new ConfigError(`Invalid or missing settings: ${names.join(', ')}`);
  }
  const value = parsed.data;
  const host = value.PRINTER_HOST ?? '';
  const usbPath = value.PRINTER_USB_PATH ?? (host.toLowerCase() === 'usb' ? 'auto' : null);
  if (!usbPath && !host) {
    throw new ConfigError('Invalid or missing settings: PRINTER_HOST');
  }
  return {
    apiBaseUrl: value.PRINT_API_URL ? value.PRINT_API_URL.replace(/\/+$/, '') : null,
    deviceToken: value.PRINT_DEVICE_TOKEN ?? null,
    printer: {
      host: usbPath ? 'usb' : host,
      port: value.PRINTER_PORT,
      usbPath,
      widthDots: value.PRINTER_WIDTH_DOTS,
      timeoutMs: value.PRINTER_TIMEOUT_MS,
      statusCheck: value.PRINTER_STATUS_CHECK,
    },
    pollIntervalMs: value.POLL_INTERVAL_MS,
    httpTimeoutMs: value.HTTP_TIMEOUT_MS,
    printedFile: value.PRINTED_JOBS_FILE,
    stopGraceMs: value.STOP_GRACE_MS,
  };
}

/** The API address and token, which running (not testing) needs. */
export function requireApi(config: AgentConfig): { baseUrl: string; token: string } {
  if (!config.apiBaseUrl || !config.deviceToken) {
    throw new ConfigError('Invalid or missing settings: PRINT_API_URL, PRINT_DEVICE_TOKEN');
  }
  return { baseUrl: config.apiBaseUrl, token: config.deviceToken };
}
