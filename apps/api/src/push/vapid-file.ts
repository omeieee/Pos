/**
 * Writes a new VAPID key pair as three ready-to-paste `.env` lines (D-37). The private key goes
 * to the file only: callers print the public key and the path, never the private key.
 */
import { writeFileSync } from 'node:fs';
import { generateVapidKeys } from './webpush.ts';

export interface VapidFileResult {
  publicKey: string;
  path: string;
}

/**
 * Refuses to replace an existing file unless `force`: a new pair orphans every device that has
 * already subscribed (they must subscribe again), so it should never happen by accident.
 * The file is private to the user (mode 0600).
 */
export function writeVapidFile(path: string, subject: string, force: boolean): VapidFileResult {
  const keys = generateVapidKeys();
  const lines = [
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_SUBJECT=${subject}`,
    '',
  ];
  writeFileSync(path, lines.join('\n'), { mode: 0o600, flag: force ? 'w' : 'wx' });
  return { publicKey: keys.publicKey, path };
}
