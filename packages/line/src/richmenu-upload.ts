import type { RichMenu } from './richmenu.ts';

export interface RichMenuUploadOptions {
  channelAccessToken: string;
  menu: RichMenu;
  /** The PNG or JPEG (at most 1 MB). */
  image: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
  fetch?: typeof fetch;
  apiBase?: string;
  dataBase?: string;
}

export class RichMenuUploadError extends Error {
  constructor(
    readonly step: 'create' | 'image' | 'default',
    readonly status: number,
  ) {
    super(`rich menu ${step} failed with HTTP ${status}`);
    this.name = 'RichMenuUploadError';
  }
}

/**
 * Creates the rich menu, uploads its picture, and makes it the default for every user, in that
 * order (a menu without a picture cannot be shown). Returns the new menu id. The token goes only
 * in the Authorization header; errors carry the step and the HTTP status, never the response body
 * or the token.
 */
export async function uploadRichMenu(options: RichMenuUploadOptions): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const api = options.apiBase ?? 'https://api.line.me';
  const data = options.dataBase ?? 'https://api-data.line.me';
  const auth = { authorization: `Bearer ${options.channelAccessToken}` };

  const created = await doFetch(`${api}/v2/bot/richmenu`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(options.menu),
  });
  if (!created.ok) throw new RichMenuUploadError('create', created.status);
  const { richMenuId } = (await created.json()) as { richMenuId?: unknown };
  if (typeof richMenuId !== 'string' || richMenuId.length === 0) {
    throw new RichMenuUploadError('create', created.status);
  }

  const image = await doFetch(`${data}/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...auth, 'content-type': options.contentType },
    body: options.image as unknown as NonNullable<RequestInit['body']>,
  });
  if (!image.ok) throw new RichMenuUploadError('image', image.status);

  const made = await doFetch(`${api}/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: auth,
  });
  if (!made.ok) throw new RichMenuUploadError('default', made.status);
  return richMenuId;
}
