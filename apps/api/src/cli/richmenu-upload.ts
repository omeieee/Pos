/**
 * Uploads the LINE rich menu from design/rich-menu/ and makes it the default. Run by the owner or
 * the main session, locally or on the VM, never by the API:
 *   LINE_CHANNEL_ACCESS_TOKEN=... LINE_LIFF_ID=... pnpm --filter @sds/api richmenu:upload [full|compact]
 * (run from the repo root; `--dir <path>` points at another copy of design/rich-menu).
 *
 * The token comes from the environment only (never argv, never a file in the repo) and is never
 * printed. Use the TEST OA's token for tests: the default menu is shown to every follower of the
 * OA the token belongs to. Re-running creates another menu and makes it the default; old menus
 * stay in LINE until deleted in the console.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRichMenu, RichMenuUploadError, uploadRichMenu } from '@sds/line';
import { liffChannelId } from '../line/liff-verify.ts';
import { fail } from './common.ts';

const MAX_IMAGE_BYTES = 1_000_000;

async function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--dir');
  // From the repo root, or from apps/api (what `pnpm --filter` uses).
  const defaultDir = existsSync('design/rich-menu') ? 'design/rich-menu' : '../../design/rich-menu';
  const dir = resolve(dirFlag >= 0 ? (args[dirFlag + 1] ?? '') : defaultDir);
  const variant = args.find((a, i) => !a.startsWith('--') && i !== dirFlag + 1) ?? 'full';
  if (variant !== 'full' && variant !== 'compact') fail('The variant is "full" or "compact".');

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const liffId = process.env.LINE_LIFF_ID;
  if (!token) fail('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  if (!liffChannelId(liffId)) fail('LINE_LIFF_ID is not set or is not a LIFF id (digits-letters).');

  let menu: ReturnType<typeof loadRichMenu>;
  let image: Buffer;
  try {
    const definition = JSON.parse(readFileSync(resolve(dir, `rich-menu-${variant}.json`), 'utf8'));
    menu = loadRichMenu(definition, { liffUrl: `https://liff.line.me/${liffId}` });
    image = readFileSync(resolve(dir, `rich-menu-${variant}.png`));
  } catch {
    return fail(`Could not read a valid rich-menu-${variant}.json and .png from ${dir}.`);
  }
  if (image.length >= MAX_IMAGE_BYTES) fail('The picture must be under 1 MB.');

  try {
    const id = await uploadRichMenu({
      channelAccessToken: token as string,
      menu,
      image,
      contentType: 'image/png',
    });
    console.log(`Rich menu ${variant} created (${id}) and set as the default.`);
  } catch (error) {
    if (error instanceof RichMenuUploadError) {
      fail(`LINE refused the ${error.step} step (HTTP ${error.status}).`);
    }
    fail('Could not reach LINE.');
  }
}

await main();
