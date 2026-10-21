import { afterEach, describe, expect, it } from 'vitest';
import { PrinterError, sendToPrinter } from './printer.ts';
import { closedPort, type FakePrinter, startFakePrinter } from './test-support.ts';

const open: FakePrinter[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((printer) => printer.close()));
});

const target = (port: number, extra: Partial<Parameters<typeof sendToPrinter>[1]> = {}) => ({
  host: '127.0.0.1',
  port,
  timeoutMs: 3_000,
  statusCheck: false,
  ...extra,
});

const codeOf = async (promise: Promise<void>) => {
  try {
    await promise;
    return 'sent';
  } catch (error) {
    return error instanceof PrinterError ? error.code : 'not a PrinterError';
  }
};

describe('sendToPrinter', () => {
  it('delivers every byte, in order, over one connection', async () => {
    const printer = await startFakePrinter();
    open.push(printer);
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
    await sendToPrinter(bytes, target(printer.port));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(printer.received).toHaveLength(1);
    expect(Buffer.from(printer.received[0] ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  it('reports PRINTER_OFFLINE when nothing listens on the port', async () => {
    expect(await codeOf(sendToPrinter(Uint8Array.of(1), target(await closedPort())))).toBe(
      'PRINTER_OFFLINE',
    );
  });

  it('reports TIMEOUT when the printer stops taking data', async () => {
    const printer = await startFakePrinter({ neverRead: true });
    open.push(printer);
    const big = new Uint8Array(40_000_000);
    expect(await codeOf(sendToPrinter(big, target(printer.port, { timeoutMs: 1_000 })))).toBe(
      'TIMEOUT',
    );
  });

  it('counts a printer that keeps the connection open as sent once the data is out', async () => {
    const printer = await startFakePrinter({ keepOpen: true });
    open.push(printer);
    const started = Date.now();
    await sendToPrinter(Uint8Array.of(1, 2, 3), target(printer.port));
    expect(Date.now() - started).toBeLessThan(2_500); // the 1.5 s close grace, not the timeout
  });

  describe('status check', () => {
    // Replies to DLE EOT 1, 2, 4 in that order.
    const sendWith = async (reply: number[]) => {
      const printer = await startFakePrinter({ reply });
      open.push(printer);
      return codeOf(
        sendToPrinter(Uint8Array.of(0x41), target(printer.port, { statusCheck: true })),
      );
    };

    it('prints when all is clear', async () => {
      expect(await sendWith([0x12, 0x12, 0x12])).toBe('sent');
    });
    it('reports OUT_OF_PAPER when the paper sensor says the roll ended', async () => {
      expect(await sendWith([0x12, 0x12, 0x72])).toBe('OUT_OF_PAPER');
    });
    it('reports COVER_OPEN when offline with the cover open', async () => {
      expect(await sendWith([0x1a, 0x16, 0x12])).toBe('COVER_OPEN');
    });
    it('reports PRINTER_OFFLINE when offline for another reason', async () => {
      expect(await sendWith([0x1a, 0x12, 0x12])).toBe('PRINTER_OFFLINE');
    });
    it('prints anyway when the printer does not answer the questions', async () => {
      const printer = await startFakePrinter();
      open.push(printer);
      const started = Date.now();
      await sendToPrinter(Uint8Array.of(0x41), target(printer.port, { statusCheck: true }));
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  });
});
