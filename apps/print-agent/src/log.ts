/**
 * One JSON line per event on stdout. Fields are limited to ids, counts and codes: never the
 * device token, never ticket text (names, notes, dishes).
 */
export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: LogFields) => void;

export const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
};
