import { canonicalQuery, encodeRfc3986, sha256Hex, signRequest } from './sigv4.ts';
import { assertKey, KEY_PATTERN, type SlipStore } from './store.ts';

/** Object name prefixes inside the one bucket (D-36). A listing of one never shows the other. */
export const R2_SLIP_PREFIX = 'slips/';
export const R2_RECEIPT_PREFIX = 'receipts/';

export interface R2StoreOptions {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  /** A secret: never log it. */
  secretAccessKey: string;
  /** `slips/` or `receipts/`: every object name starts with it. */
  prefix: string;
  /** Tests point this at a local fake; otherwise `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Keys per ListObjectsV2 page (R2 allows 1000). Tests use a small one to cover paging. */
  pageSize?: number;
}

const ENTRY = /<Contents>([\s\S]*?)<\/Contents>/g;
const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/**
 * The slip store on Cloudflare R2 (S3-compatible API, region `auto`, D-36). Path-style requests
 * (`/<bucket>/<prefix><key>`), SigV4 over `fetch`. Keys are the same random 32 characters as on
 * disk; the prefix keeps slips and receipts apart. Failures throw with the HTTP status only
 * (an error body can echo the request). Class A operations (put, list) are the ones the free
 * quota counts, so `list` is only called by the nightly jobs, never by a request.
 */
export function createR2SlipStore(options: R2StoreOptions): SlipStore {
  const endpoint = new URL(
    options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
  );
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pageSize = options.pageSize ?? 1000;
  const basePath = endpoint.pathname.replace(/\/$/, '');

  async function send(
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    const query = canonicalQuery(params);
    const headers = signRequest({
      method,
      path: `${basePath}${path}`,
      query,
      host: endpoint.host,
      payloadHash: sha256Hex(body ?? ''),
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: 'auto',
      now: now(),
    });
    // `fetch` sets `host` itself from the URL; the signed value is the same text.
    const { host: _host, ...sendHeaders } = headers;
    return doFetch(`${endpoint.origin}${basePath}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: sendHeaders,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  const bucketPath = `/${encodeRfc3986(options.bucket)}`;
  const objectPath = (key: string) => {
    assertKey(key);
    return `${bucketPath}/${options.prefix}${key}`;
  };
  const failed = (action: string, res: Response) =>
    new Error(`R2 ${action} failed with status ${res.status}`);

  return {
    async put(key, bytes) {
      const res = await send('PUT', objectPath(key), {}, bytes);
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) throw failed('put', res);
    },
    async get(key) {
      const res = await send('GET', objectPath(key));
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!res.ok) throw failed('get', res);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await send('DELETE', objectPath(key));
      await res.arrayBuffer().catch(() => undefined);
      // S3 answers 204 whether or not the object existed; a 404 is not an error either.
      if (!res.ok && res.status !== 404) throw failed('delete', res);
    },
    async list() {
      const found: { key: string; modifiedAt: Date; size: number }[] = [];
      let token: string | undefined;
      do {
        const res = await send('GET', bucketPath, {
          'list-type': '2',
          prefix: options.prefix,
          'max-keys': String(pageSize),
          ...(token ? { 'continuation-token': token } : {}),
        });
        if (!res.ok) throw failed('list', res);
        const xml = await res.text();
        for (const match of xml.matchAll(ENTRY)) {
          const entry = match[1] ?? '';
          const key = (tag(entry, 'Key') ?? '').slice(options.prefix.length);
          if (!KEY_PATTERN.test(key)) continue; // anything foreign in the prefix
          found.push({
            key,
            modifiedAt: new Date(tag(entry, 'LastModified') ?? 0),
            size: Number(tag(entry, 'Size') ?? 0),
          });
        }
        token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
      } while (token);
      return found;
    },
  };
}
