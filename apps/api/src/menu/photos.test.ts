/**
 * Menu photos (D-21): PUT/DELETE need menu.edit, the GET is public and serves only photos of live
 * items in active categories, checked by magic bytes and size, cached forever by version.
 */
import { type ItemDto, itemDtoSchema, publicMenuResponseSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
function call(method: Method, url: string, token: string | undefined, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

function put(
  token: string | undefined,
  id: string,
  bytes: Buffer | Uint8Array,
  contentType: string | undefined,
) {
  return h.app.inject({
    method: 'PUT',
    url: `/v1/menu/items/${id}/photo`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    payload: Buffer.from(bytes),
    remoteAddress: h.nextIp(),
  });
}

const getPhoto = (id: string, v: string | number, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/menu/items/${id}/photo?v=${v}`,
    headers,
    remoteAddress: h.nextIp(),
  });

const uid = () => crypto.randomUUID().slice(0, 8);

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** A different valid PNG (header only is enough for the checks: the size field differs). */
const png = (width: number, height: number, padTo = 0) => {
  const b = Buffer.alloc(Math.max(33, padTo));
  PNG.copy(b, 0, 0, 33);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};
/** A minimal JPEG header with a frame: enough for the type and size checks. */
const jpeg = (width: number, height: number) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);

async function newCategory(token: string) {
  const res = await call('POST', '/v1/menu/categories', token, { nameTh: `หมวด ${uid()}` });
  return res.json() as { id: string; version: number };
}
async function newItem(token: string, categoryId: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/menu/items', token, {
    categoryId,
    nameTh: `เมนู ${uid()}`,
    priceSatang: 5000,
    estCostSatang: 2200,
    channels: ['storefront', 'line'],
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`item: ${res.statusCode} ${res.body}`);
  return itemDtoSchema.parse(res.json());
}
async function itemWithPhoto(token: string, bytes: Buffer = PNG) {
  const item = await newItem(token, (await newCategory(token)).id);
  const res = await put(token, item.id, bytes, 'image/png');
  if (res.statusCode !== 200) throw new Error(`photo: ${res.statusCode} ${res.body}`);
  return { item, dto: itemDtoSchema.parse(res.json()) };
}
const dtoOf = (res: { json(): unknown }) => itemDtoSchema.parse(res.json()) as ItemDto;
const count = async (sql: string, params: unknown[]) =>
  Number(((await h.client.query<{ n: number }>(sql, params)).rows[0] as { n: number }).n);

// ---------- who may do what (tasks 1 and 2) ----------

describe('permissions', () => {
  test('PUT and DELETE need a session, and menu.edit: cashiers and kitchen get 403 before the body is read', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    expect((await put(undefined, item.id, PNG, 'image/png')).statusCode).toBe(401);
    expect((await call('DELETE', `/v1/menu/items/${item.id}/photo`, undefined)).statusCode).toBe(
      401,
    );
    for (const role of ['cashier', 'kitchen'] as const) {
      const token = await as(role);
      const up = await put(token, item.id, PNG, 'image/png');
      expect(up.statusCode, role).toBe(403);
      expect(up.json()).toMatchObject({ code: 'FORBIDDEN' });
      // Too big to be accepted at all: the answer is still the 403, so the guard ran first.
      expect((await put(token, item.id, Buffer.alloc(300_000), 'image/png')).statusCode, role).toBe(
        403,
      );
      expect(
        (await call('DELETE', `/v1/menu/items/${item.id}/photo`, token)).statusCode,
        role,
      ).toBe(403);
    }
    expect(
      dtoOf(await call('GET', `/v1/menu/items/${item.id}`, manager)).photoVersion ?? null,
    ).toBeNull();
  });

  test('cashiers and kitchen cannot create, edit, archive or restore items, groups, options or categories', async () => {
    const manager = await as('manager');
    const cat = await newCategory(manager);
    const item = await newItem(manager, cat.id);
    const group = (
      await call('POST', '/v1/menu/modifier-groups', manager, {
        nameTh: `g ${uid()}`,
        minSelect: 0,
        maxSelect: 1,
        options: [{ nameTh: 'o' }],
      })
    ).json() as { id: string; options: { id: string }[] };
    const optionId = group.options[0]?.id ?? '';
    for (const role of ['cashier', 'kitchen'] as const) {
      const token = await as(role);
      const denied = [
        await call('POST', '/v1/menu/items', token, {
          categoryId: cat.id,
          nameTh: 'x',
          priceSatang: 1,
          channels: ['storefront'],
        }),
        await call('PATCH', `/v1/menu/items/${item.id}`, token, {
          expectedVersion: 1,
          priceSatang: 1,
        }),
        await call('PATCH', `/v1/menu/items/${item.id}`, token, {
          expectedVersion: 1,
          archived: true,
        }),
        await call('PATCH', `/v1/menu/items/${item.id}`, token, {
          expectedVersion: 1,
          archived: false,
        }),
        await call('DELETE', `/v1/menu/items/${item.id}`, token),
        await call('PATCH', `/v1/menu/categories/${cat.id}`, token, {
          expectedVersion: 1,
          active: false,
        }),
        await call('DELETE', `/v1/menu/categories/${cat.id}`, token),
        await call('PATCH', `/v1/menu/modifier-groups/${group.id}`, token, {
          expectedVersion: 1,
          nameTh: 'y',
        }),
        await call('DELETE', `/v1/menu/modifier-groups/${group.id}`, token),
        await call('POST', `/v1/menu/modifier-groups/${group.id}/options`, token, { nameTh: 'o2' }),
        await call('PATCH', `/v1/menu/modifier-options/${optionId}`, token, {
          expectedVersion: 1,
          nameTh: 'z',
        }),
        await call('DELETE', `/v1/menu/modifier-options/${optionId}`, token),
      ];
      for (const [i, res] of denied.entries()) {
        expect(res.statusCode, `${role} #${i}`).toBe(403);
      }
      // The sold-out toggle stays open to them.
      expect(
        (
          await call('PATCH', `/v1/menu/items/${item.id}/availability`, token, {
            isAvailable: false,
          })
        ).statusCode,
        role,
      ).toBe(200);
      await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, { isAvailable: true });
    }
    // Nothing was changed by any of the refused calls.
    expect(dtoOf(await call('GET', `/v1/menu/items/${item.id}`, manager))).toMatchObject({
      priceSatang: 5000,
      archived: false,
    });
  });
});

// ---------- upload, public read ----------

describe('upload and the public read', () => {
  test('a manager uploads; the item says so; anyone can read it by its versioned URL', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    expect(item.photoVersion ?? null).toBeNull();

    const res = await put(manager, item.id, PNG, 'image/png');
    expect(res.statusCode).toBe(200);
    const dto = dtoOf(res);
    expect(dto.photoVersion).toBe(dto.version); // the version of the write that made it
    expect(dto.photoVersion).toBeGreaterThan(1);
    expect(dto.photoUrl).toBe(`/v1/menu/items/${item.id}/photo?v=${dto.photoVersion}`);
    expect(dto.version).toBe(item.version + 1);
    expect(dto.rev).toBeGreaterThan(item.rev);
    expect(JSON.stringify(dto)).not.toMatch(/estCost|bytes/);

    // No Authorization header at all: this is what an <img> sends.
    const img = await getPhoto(item.id, dto.photoVersion ?? 0);
    expect(img.statusCode).toBe(200);
    expect(Buffer.from(img.rawPayload).equals(PNG)).toBe(true);
    expect(img.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(img.headers.etag).toMatch(/^"[\w.-]+"$/);
    expect(String(img.headers['content-length'])).toBe(String(PNG.length));
  });

  test('a repeat request with the ETag is a 304 with no body', async () => {
    const { item, dto } = await itemWithPhoto(await as('manager'));
    const first = await getPhoto(item.id, dto.photoVersion ?? 0);
    const again = await getPhoto(item.id, dto.photoVersion ?? 0, {
      'if-none-match': String(first.headers.etag),
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect(String(again.headers['cache-control'])).toContain('immutable');
  });

  test('the bytes column is selected only to serve a 200: never for a 304 or a 404', async () => {
    const { item, dto } = await itemWithPhoto(await as('manager'));
    const v = dto.photoVersion ?? 0;
    const etag = String((await getPhoto(item.id, v)).headers.etag);

    const selectsBytes = async (run: () => Promise<{ statusCode: number }>) => {
      const seen: string[] = [];
      const real = h.client.query.bind(h.client);
      const spy = vi.spyOn(h.client, 'query').mockImplementation(((
        sql: string,
        ...rest: unknown[]
      ) => {
        seen.push(String(sql));
        return (real as (...a: unknown[]) => unknown)(sql, ...rest);
      }) as typeof h.client.query);
      try {
        const res = await run();
        const bytes = seen.some((q) => /^\s*select\b[\s\S]*"bytes"/i.test(q));
        return { status: res.statusCode, bytes, queries: seen.length };
      } finally {
        spy.mockRestore();
      }
    };

    const ok = await selectsBytes(() => getPhoto(item.id, v));
    expect(ok).toMatchObject({ status: 200, bytes: true }); // the probe really sees the column
    const notModified = await selectsBytes(() => getPhoto(item.id, v, { 'if-none-match': etag }));
    expect(notModified).toMatchObject({ status: 304, bytes: false });
    expect(notModified.queries).toBeGreaterThan(0);
    expect(await selectsBytes(() => getPhoto(item.id, v + 1))).toMatchObject({
      status: 404,
      bytes: false,
    });
    expect(await selectsBytes(() => getPhoto(crypto.randomUUID(), v))).toMatchObject({
      status: 404,
      bytes: false,
    });
  });

  test('the stored type is the detected one: a JPEG is served as image/jpeg', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const res = await put(manager, item.id, jpeg(800, 600), 'image/jpeg');
    expect(res.statusCode).toBe(200);
    const img = await getPhoto(item.id, dtoOf(res).photoVersion ?? 0);
    expect(img.headers['content-type']).toBe('image/jpeg');
  });

  test('a stale, wrong or missing version is the same 404 as an unknown item, and is never cached', async () => {
    const { item, dto } = await itemWithPhoto(await as('manager'));
    const v = dto.photoVersion ?? 0;
    const unknown = await getPhoto(crypto.randomUUID(), v);
    expect(unknown.statusCode).toBe(404);
    const cases = [
      await getPhoto(item.id, v - 1),
      await getPhoto(item.id, v + 1),
      await getPhoto(item.id, 'abc'),
      await getPhoto(item.id, 0),
      await h.app.inject({
        method: 'GET',
        url: `/v1/menu/items/${item.id}/photo`,
        remoteAddress: h.nextIp(),
      }),
      await h.app.inject({
        method: 'GET',
        url: `/v1/menu/items/not-a-uuid/photo?v=${v}`,
        remoteAddress: h.nextIp(),
      }),
      unknown,
    ];
    for (const res of cases) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  test('replacing makes a new version; the old URL stops working; the same bytes change nothing', async () => {
    const manager = await as('manager');
    const { item, dto: first } = await itemWithPhoto(manager);
    const other = png(640, 480, 200);
    const second = dtoOf(await put(manager, item.id, other, 'image/png'));
    expect(second.photoVersion).toBeGreaterThan(first.photoVersion ?? 0);
    expect((await getPhoto(item.id, first.photoVersion ?? 0)).statusCode).toBe(404);
    expect(
      Buffer.from((await getPhoto(item.id, second.photoVersion ?? 0)).rawPayload).equals(other),
    ).toBe(true);
    expect(
      await count('select count(*)::int as n from menu_item_photos where menu_item_id = $1', [
        item.id,
      ]),
    ).toBe(1);

    const events = h.events.length;
    const audits = (await h.auditRows(item.id)).length;
    const same = dtoOf(await put(manager, item.id, other, 'image/png'));
    expect(same).toMatchObject({
      version: second.version,
      rev: second.rev,
      photoVersion: second.photoVersion,
    });
    expect(h.events.length).toBe(events);
    expect((await h.auditRows(item.id)).length).toBe(audits);
  });

  test('delete removes it; a photo added later never reuses an old version', async () => {
    const manager = await as('manager');
    const { item, dto: first } = await itemWithPhoto(manager);
    const del = await call('DELETE', `/v1/menu/items/${item.id}/photo`, manager);
    expect(del.statusCode).toBe(200);
    expect(dtoOf(del).photoVersion ?? null).toBeNull();
    expect(dtoOf(del).photoUrl ?? null).toBeNull();
    expect((await getPhoto(item.id, first.photoVersion ?? 0)).statusCode).toBe(404);
    expect(
      await count('select count(*)::int as n from menu_item_photos where menu_item_id = $1', [
        item.id,
      ]),
    ).toBe(0);

    const again = dtoOf(await put(manager, item.id, png(300, 300, 100), 'image/png'));
    expect(again.photoVersion).toBeGreaterThan(first.photoVersion ?? 0);
    // A browser that cached the first URL as immutable is never served the new image under it.
    expect((await getPhoto(item.id, first.photoVersion ?? 0)).statusCode).toBe(404);
    expect((await getPhoto(item.id, again.photoVersion ?? 0)).statusCode).toBe(200);

    // Deleting a photo that is not there is not an error and changes nothing.
    const none = await newItem(manager, (await newCategory(manager)).id);
    const events = h.events.length;
    const res = await call('DELETE', `/v1/menu/items/${none.id}/photo`, manager);
    expect(dtoOf(res)).toMatchObject({ version: none.version });
    expect(h.events.length).toBe(events);
  });

  test('only live items in active categories are served; sold-out items keep their picture', async () => {
    const manager = await as('manager');
    const { item, dto } = await itemWithPhoto(manager);
    const v = dto.photoVersion ?? 0;
    expect((await getPhoto(item.id, v)).statusCode).toBe(200);

    // Sold out: still on the staff till.
    await call('PATCH', `/v1/menu/items/${item.id}/availability`, manager, { isAvailable: false });
    expect((await getPhoto(item.id, v)).statusCode).toBe(200);

    // Archived: gone from every reader, and back when restored.
    const current = dtoOf(await call('GET', `/v1/menu/items/${item.id}`, manager));
    const archived = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: current.version,
      archived: true,
    });
    expect((await getPhoto(item.id, v)).statusCode).toBe(404);
    const restored = await call('PATCH', `/v1/menu/items/${item.id}`, manager, {
      expectedVersion: dtoOf(archived).version,
      archived: false,
    });
    expect(dtoOf(restored).photoVersion).toBe(v); // an edit that does not touch the photo keeps its version
    expect((await getPhoto(item.id, v)).statusCode).toBe(200);

    // An inactive category hides its items' photos too.
    const cat = await newCategory(await as('manager'));
    const inCat = await itemWithPhotoIn(manager, cat.id);
    expect((await getPhoto(inCat.id, inCat.v)).statusCode).toBe(200);
    await call('DELETE', `/v1/menu/categories/${cat.id}`, manager);
    expect((await getPhoto(inCat.id, inCat.v)).statusCode).toBe(404);
  });

  async function itemWithPhotoIn(token: string, categoryId: string) {
    const item = await newItem(token, categoryId);
    const dto = dtoOf(await put(token, item.id, PNG, 'image/png'));
    return { id: item.id, v: dto.photoVersion ?? 0 };
  }

  test('the public menu and the staff lists point at the photo; no cost anywhere', async () => {
    const manager = await as('manager');
    const { item, dto } = await itemWithPhoto(manager);
    const menu = publicMenuResponseSchema.parse((await call('GET', '/v1/menu', undefined)).json());
    const listed = menu.categories.flatMap((c) => c.items).find((i) => i.id === item.id);
    expect(listed?.photoUrl).toBe(dto.photoUrl);
    const plain = menu.categories.flatMap((c) => c.items).find((i) => i.id !== item.id);
    expect(
      plain === undefined ||
        plain.photoUrl === null ||
        plain.photoUrl === undefined ||
        plain.photoUrl.includes('?v='),
    ).toBe(true);

    const staff = (await call('GET', '/v1/menu/items', await as('cashier'))).json() as {
      items: ItemDto[];
    };
    expect(staff.items.find((i) => i.id === item.id)).toMatchObject({
      photoVersion: dto.photoVersion,
      photoUrl: dto.photoUrl,
    });
    expect(JSON.stringify([menu, staff])).not.toMatch(/estCost|costDelta|"bytes"/);
  });
});

// ---------- what an upload may be ----------

describe('validation', () => {
  async function refused(
    bytes: Buffer,
    contentType: string | undefined,
    status: number,
    code?: string,
  ) {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const events = h.events.length;
    const res = await put(manager, item.id, bytes, contentType);
    expect(res.statusCode, `${contentType} ${res.body}`).toBe(status);
    const body = res.json() as { code: string; message: string; details: unknown };
    expect(Object.keys(body).sort()).toEqual(['code', 'details', 'message']);
    if (code) expect(body.code).toBe(code);
    // Nothing was stored, audited or announced.
    expect(
      await count('select count(*)::int as n from menu_item_photos where menu_item_id = $1', [
        item.id,
      ]),
    ).toBe(0);
    expect(dtoOf(await call('GET', `/v1/menu/items/${item.id}`, manager)).version).toBe(
      item.version,
    );
    expect((await h.auditRows(item.id)).filter((a) => a.action.includes('photo'))).toEqual([]);
    expect(h.events.length).toBe(events);
  }

  test('not an image, whatever the client says', async () => {
    await refused(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'image/png',
      415,
      'PHOTO_NOT_AN_IMAGE',
    );
    await refused(
      Buffer.from('<html><script>alert(1)</script></html>'),
      'image/jpeg',
      415,
      'PHOTO_NOT_AN_IMAGE',
    );
    await refused(Buffer.from('GIF89a\x01\x00\x01\x00'), 'image/webp', 415, 'PHOTO_NOT_AN_IMAGE');
  });

  test('a declared type that differs from the detected one', async () => {
    await refused(PNG, 'image/jpeg', 415, 'PHOTO_TYPE_MISMATCH');
    await refused(jpeg(100, 100), 'image/png', 415, 'PHOTO_TYPE_MISMATCH');
  });

  test('a content type the route does not take: html, svg, json, none', async () => {
    await refused(PNG, 'text/html', 415);
    await refused(PNG, 'image/svg+xml', 415);
    await refused(PNG, 'image/gif', 415);
    await refused(PNG, 'application/json', 400); // the JSON parser, not the photo route, reads it
    await refused(PNG, undefined, 415);
  });

  test('empty body, more than 1200 px on a side, more than the byte cap', async () => {
    await refused(Buffer.alloc(0), 'image/png', 422, 'PHOTO_EMPTY');
    await refused(png(1201, 600), 'image/png', 422, 'PHOTO_TOO_MANY_PIXELS');
    await refused(jpeg(600, 1300), 'image/jpeg', 422, 'PHOTO_TOO_MANY_PIXELS');
    await refused(png(100, 100, 200_001), 'image/png', 413);
  });

  test('exactly the cap and 1200 px are accepted', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const res = await put(manager, item.id, png(1200, 1200, 200_000), 'image/png');
    expect(res.statusCode).toBe(200);
  });

  test('an unknown item is 404 for a manager', async () => {
    const res = await put(await as('manager'), crypto.randomUUID(), PNG, 'image/png');
    expect(res.statusCode).toBe(404);
  });

  test('the body limit applies to the photo route only', async () => {
    const manager = await as('manager');
    const big = await call('POST', '/v1/menu/categories', manager, { nameTh: 'x'.repeat(300_000) });
    expect(big.statusCode).toBe(400); // over 200 KB, yet an ordinary validation error: the cap is on the photo route
  });
});

// ---------- audit and events ----------

describe('audit and events', () => {
  test('set and remove are each audited without the bytes and published once after commit', async () => {
    const manager = await as('manager');
    const item = await newItem(manager, (await newCategory(manager)).id);
    const before = h.events.length;
    const dto = dtoOf(await put(manager, item.id, PNG, 'image/png'));
    const set = (await h.auditRows(item.id)).find((a) => a.action === 'menu.item_photo_set');
    expect(set).toMatchObject({
      entity: 'menu_items',
      actorType: 'staff',
      after: {
        photoVersion: dto.photoVersion,
        byteSize: PNG.length,
        contentType: 'image/png',
        width: 1,
        height: 1,
      },
    });
    expect(JSON.stringify(set)).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(set)).not.toContain(PNG.toString('hex'));

    const removed = dtoOf(await call('DELETE', `/v1/menu/items/${item.id}/photo`, manager));
    const gone = (await h.auditRows(item.id)).find((a) => a.action === 'menu.item_photo_remove');
    expect(gone).toMatchObject({
      before: { photoVersion: dto.photoVersion },
      after: { photoVersion: null },
    });

    const published = h.events.slice(before);
    expect(published).toEqual([
      expect.objectContaining({ type: 'menu.upserted', kind: 'item', id: item.id, rev: dto.rev }),
      expect.objectContaining({
        type: 'menu.upserted',
        kind: 'item',
        id: item.id,
        rev: removed.rev,
      }),
    ]);
    // The event carries the version, never the picture.
    expect(JSON.stringify(published)).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(published)).toContain(`"photoVersion":${dto.photoVersion}`);
  });
});

// ---------- the public route is limited ----------

describe('rate limit', () => {
  test('the public read is limited per IP', async () => {
    const ip = '192.0.2.77';
    let limited = 0;
    for (let i = 0; i < 640; i++) {
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/menu/items/not-a-uuid/photo?v=1',
        remoteAddress: ip,
      });
      if (res.statusCode === 429) {
        limited += 1;
        expect(res.json()).toMatchObject({ code: 'RATE_LIMITED' });
      }
    }
    expect(limited).toBeGreaterThan(0);
    // Another address is not affected.
    expect((await getPhoto(crypto.randomUUID(), 1)).statusCode).toBe(404);
  });
});
