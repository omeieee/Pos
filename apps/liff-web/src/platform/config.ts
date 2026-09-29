/**
 * Platform config (D-19): the API base URL comes from build config, never from the page
 * origin, so the same build can run on Pages today and inside a native shell later.
 */

/** Joins a base URL and an absolute path with exactly one slash between them. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export const apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? '';

export function apiUrl(path: string): string {
  return joinUrl(apiBaseUrl, path);
}
