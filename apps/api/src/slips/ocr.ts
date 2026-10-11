import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

/**
 * Reads the text of a slip picture (D-26). The only implementation that ships is Tesseract running
 * on this machine: a slip shows a customer's name and account number, so it is never sent to a
 * cloud service. The text is handed to the caller and dropped; it is never stored or logged.
 */
export interface SlipOcr {
  /** The recognised text. Rejects when the reader fails, runs out of time or finds nothing usable. */
  read(image: Buffer): Promise<string>;
}

/** What `spawn` needs to be: tests give a fake process. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface TesseractOptions {
  /** Languages, `tha+eng` by default (Thai labels help to tell the amount from other numbers). */
  lang: string;
  /** The reader is killed after this long. */
  timeoutMs: number;
  /** The executable; found on PATH by default. */
  command?: string;
  spawn?: SpawnFn;
}

/** A page of text is a few KB; a reader that prints more than this has gone wrong. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Runs `tesseract stdin stdout` for ONE picture: the bytes go in through stdin (no copy of the slip
 * on the disk) and the text comes out of stdout. One thread, and a low priority (`nice`) so the API
 * stays responsive on a 1 GB / 1/8 CPU machine. stderr is ignored: it may echo what was read.
 */
export function createTesseractOcr(options: TesseractOptions): SlipOcr {
  const run = options.spawn ?? (nodeSpawn as SpawnFn);
  const command = options.command ?? 'tesseract';
  return {
    read(image) {
      return new Promise<string>((resolve, reject) => {
        const args = ['stdin', 'stdout', '-l', options.lang, '--psm', '6'];
        const lowPriority = process.platform !== 'win32';
        const child = lowPriority
          ? run('nice', ['-n', '10', command, ...args], spawnOptions)
          : run(command, args, spawnOptions);
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (done: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done();
        };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(() => reject(new Error('OCR_TIMEOUT')));
        }, options.timeoutMs);

        child.once('error', () => finish(() => reject(new Error('OCR_FAILED'))));
        child.stdin?.once('error', () => undefined); // a reader that exits early: `close` reports it
        child.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES) {
            child.kill('SIGKILL');
            finish(() => reject(new Error('OCR_OUTPUT_TOO_LARGE')));
            return;
          }
          chunks.push(chunk);
        });
        child.once('close', (code) =>
          finish(() =>
            code === 0
              ? resolve(Buffer.concat(chunks).toString('utf8'))
              : reject(new Error('OCR_FAILED')),
          ),
        );
        child.stdin?.end(image);
      });
    },
  };
}

const spawnOptions: SpawnOptions = {
  stdio: ['pipe', 'pipe', 'ignore'],
  // One CPU thread: OpenMP would otherwise start one per core.
  env: { ...process.env, OMP_THREAD_LIMIT: '1' },
};
