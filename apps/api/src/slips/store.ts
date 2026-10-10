import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where transfer slip images live (D-24: a directory on the VM's disk, behind this seam so a
 * bucket can replace it later). The database holds only the KEY (`payments.slip_image_key`);
 * the key is random, never derived from a customer, an order or a payment.
 */
export interface SlipStore {
  put(key: string, bytes: Buffer): Promise<void>;
  /** The bytes, or null when there is no such file. */
  get(key: string): Promise<Buffer | null>;
  /** Deleting a file that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Every stored file with its last write time (for the orphan sweep). Temporary files are not listed. */
  list(): Promise<{ key: string; modifiedAt: Date }[]>;
}

/** 24 random bytes: 32 URL-safe characters. */
export const newSlipKey = (): string => randomBytes(24).toString('base64url');

const KEY_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** A key is also a file name: anything but our own shape is refused, so it can never be a path. */
function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('invalid slip key');
}

/** Files in one directory, written to a temporary name and renamed so a reader never sees half a file. */
export function createFsSlipStore(directory: string): SlipStore {
  const ready = mkdir(directory, { recursive: true });
  // A failed mkdir is reported by the first put, not as an unhandled rejection at start-up.
  ready.catch(() => undefined);
  return {
    async put(key, bytes) {
      assertKey(key);
      await ready;
      const target = join(directory, key);
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      assertKey(key);
      try {
        return await readFile(join(directory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      assertKey(key);
      try {
        await unlink(join(directory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    async list() {
      await ready;
      const found: { key: string; modifiedAt: Date }[] = [];
      for (const name of await readdir(directory)) {
        if (!KEY_PATTERN.test(name)) continue; // temporary files and anything foreign
        try {
          found.push({ key: name, modifiedAt: (await stat(join(directory, name))).mtime });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return found;
    },
  };
}

/** For tests (and the default when nothing is configured): nothing survives a restart. */
export interface MemorySlipStore extends SlipStore {
  keys(): string[];
}

export function createMemorySlipStore(): MemorySlipStore {
  const files = new Map<string, Buffer>();
  const written = new Map<string, Date>();
  return {
    async put(key, bytes) {
      assertKey(key);
      files.set(key, Buffer.from(bytes));
      written.set(key, new Date());
    },
    async get(key) {
      assertKey(key);
      return files.get(key) ?? null;
    },
    async delete(key) {
      assertKey(key);
      files.delete(key);
      written.delete(key);
    },
    async list() {
      return [...files.keys()].map((key) => ({ key, modifiedAt: written.get(key) ?? new Date() }));
    },
    keys: () => [...files.keys()],
  };
}
