import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256Hex, signRequest } from '../slips/sigv4.ts';

const ACCESS = 'AKIDEXAMPLE0000000000';
const SECRET = 'secret-for-tests-only-0123456789abcdef';
const BUCKET = 'test-bucket';

export const FAKE_S3_CREDENTIALS = {
  accountId: 'a'.repeat(32),
  bucket: BUCKET,
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
};

export interface FakeS3 {
  endpoint: string;
  objects: Map<string, { bytes: Buffer; at: Date }>;
  requests: { method: string; path: string; query: string }[];
  failNext(n: number): void;
  close(): Promise<void>;
}

/** A tiny S3: PUT/GET/DELETE objects and ListObjectsV2 with paging; it checks every signature. */
export function startFakeS3(): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const requests: FakeS3['requests'] = [];
  let failNext = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push({ method: req.method ?? '', path: url.pathname, query: url.search });
      // Recompute the signature from what arrived.
      const auth = String(req.headers.authorization ?? '');
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];
      const extra: Record<string, string> = {};
      for (const name of signed) {
        if (!['host', 'x-amz-content-sha256', 'x-amz-date'].includes(name)) {
          extra[name] = String(req.headers[name]);
        }
      }
      const expected = signRequest({
        method: req.method ?? '',
        path: url.pathname,
        query: url.search.slice(1),
        host: String(req.headers.host),
        headers: extra,
        payloadHash: sha256Hex(body),
        accessKeyId: ACCESS,
        secretAccessKey: SECRET,
        region: 'auto',
        now: new Date(
          String(req.headers['x-amz-date']).replace(
            /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,
            '$1-$2-$3T$4:$5:$6Z',
          ),
        ),
      }).authorization;
      if (auth !== expected || req.headers['x-amz-content-sha256'] !== sha256Hex(body)) {
        res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      if (failNext > 0) {
        failNext -= 1;
        res.writeHead(500).end('boom');
        return;
      }
      const prefix = `/${BUCKET}/`;
      if (url.pathname === `/${BUCKET}` && req.method === 'GET') {
        const wanted = url.searchParams.get('prefix') ?? '';
        const max = Number(url.searchParams.get('max-keys') ?? 1000);
        const after = url.searchParams.get('continuation-token');
        const names = [...objects.keys()].filter((n) => n.startsWith(wanted)).sort();
        const start = after ? names.findIndex((n) => n > after) : 0;
        const page = start < 0 ? [] : names.slice(start, start + max);
        const more = start >= 0 && start + max < names.length;
        const xml =
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>` +
          (more ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : '') +
          page
            .map((n) => {
              const o = objects.get(n);
              return `<Contents><Key>${n}</Key><LastModified>${o?.at.toISOString()}</LastModified><Size>${o?.bytes.length}</Size></Contents>`;
            })
            .join('') +
          '</ListBucketResult>';
        res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
        return;
      }
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      if (req.method === 'PUT') {
        objects.set(name, { bytes: body, at: new Date() });
        res.writeHead(200).end();
      } else if (req.method === 'GET') {
        const o = objects.get(name);
        if (!o) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
        else res.writeHead(200).end(o.bytes);
      } else if (req.method === 'DELETE') {
        objects.delete(name);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        objects,
        requests,
        failNext: (n) => {
          failNext = n;
        },
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}
