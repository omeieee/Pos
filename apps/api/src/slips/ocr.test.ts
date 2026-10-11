import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTesseractOcr, type SpawnFn } from './ocr.ts';

afterEach(() => vi.useRealTimers());

/** A stand-in process: what was written to stdin, and a way to end it the way a real one does. */
function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  const received: Buffer[] = [];
  child.stdin.on('data', (chunk: Buffer) => received.push(chunk));
  return { child, received: () => Buffer.concat(received) };
}

function ocrWith(child: unknown, calls: { command: string; args: string[] }[] = []) {
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    return child as ChildProcess;
  };
  return createTesseractOcr({ lang: 'tha+eng', timeoutMs: 1000, spawn });
}

describe('createTesseractOcr', () => {
  test('sends the picture through stdin and returns what came out of stdout', async () => {
    const { child, received } = fakeProcess();
    const calls: { command: string; args: string[] }[] = [];
    const reading = ocrWith(child, calls).read(Buffer.from('picture'));
    child.stdout.write('จำนวน: 60.00 บาท\n');
    child.emit('close', 0);
    expect(await reading).toBe('จำนวน: 60.00 บาท\n');
    expect(received().toString()).toBe('picture');
    const all = calls[0]?.args.join(' ') ?? '';
    expect(all).toContain('stdin stdout -l tha+eng');
  });

  test('a reader that fails is an error, without its output', async () => {
    const { child } = fakeProcess();
    const reading = ocrWith(child).read(Buffer.from('x'));
    child.stdout.write('some name and account number');
    child.emit('close', 1);
    await expect(reading).rejects.toThrow('OCR_FAILED');
    await expect(reading).rejects.not.toThrow(/account/);
  });

  test('a reader that is not installed is an error', async () => {
    const { child } = fakeProcess();
    const reading = ocrWith(child).read(Buffer.from('x'));
    child.emit('error', new Error('spawn tesseract ENOENT'));
    await expect(reading).rejects.toThrow('OCR_FAILED');
  });

  test('a reader that takes too long is killed', async () => {
    vi.useFakeTimers();
    const { child } = fakeProcess();
    const reading = ocrWith(child).read(Buffer.from('x'));
    const assertion = expect(reading).rejects.toThrow('OCR_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('a reader that prints too much is killed', async () => {
    const { child } = fakeProcess();
    const reading = ocrWith(child).read(Buffer.from('x'));
    const assertion = expect(reading).rejects.toThrow('OCR_OUTPUT_TOO_LARGE');
    child.stdout.write(Buffer.alloc(300 * 1024, 65));
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
