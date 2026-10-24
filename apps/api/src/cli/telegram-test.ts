/**
 * Sends one MADE-UP sample payment alert to the Telegram group (D-42), so the owner can check the
 * bot token and the chat id before real orders use them. Run on the VM (it reads the same .env):
 *   cd /opt/sds && ./dc run --rm --no-deps api node dist/telegram-test.js
 * or locally with the three TELEGRAM_* variables set:
 *   pnpm --filter @sds/api telegram:test
 * The sample has no real customer, no photo and no database. The token is never printed; a refusal
 * prints Telegram's status and its short reason (for example "chat not found").
 */
import { loadConfig } from '../config.ts';
import { redactTelegramToken } from '../redact.ts';
import { alertText } from '../telegram/message.ts';
import { fail } from './common.ts';

const SAMPLE = alertText({
  kind: 'paid',
  orderNo: 'TEST-001',
  totalSatang: 6200,
  lineName: 'ตัวอย่าง (ข้อความทดสอบ)',
  recipientName: 'คุณทดสอบ',
  building: 'ตึก A',
  lines: [
    { name: 'ก๋วยเตี๋ยวต้มยำ', qty: 1 },
    { name: 'น้ำเปล่า', qty: 2 },
  ],
});

async function main() {
  let telegram: ReturnType<typeof loadConfig>['telegram'];
  try {
    telegram = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
      AUTH_SECRET_KEY: process.env.AUTH_SECRET_KEY ?? Buffer.alloc(32, 1).toString('base64'),
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      PUBLIC_API_BASE_URL: process.env.PUBLIC_API_BASE_URL,
    }).telegram;
  } catch (error) {
    // The message names variables and rules only, never values.
    fail(error instanceof Error ? error.message : 'Invalid Telegram settings.');
  }
  if (!telegram) {
    fail('Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and PUBLIC_API_BASE_URL first (all three).');
  }
  let status: number;
  let reason = '';
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegram.chatId, text: `${SAMPLE}\n\n(ข้อความทดสอบ)` }),
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const body = (await response.json().catch(() => null)) as { description?: unknown } | null;
    if (typeof body?.description === 'string') reason = redactTelegramToken(body.description);
  } catch (error) {
    fail(`Could not reach Telegram (${error instanceof Error ? error.name : 'error'}).`);
  }
  if (status >= 200 && status < 300) {
    console.log('Sent. Look for the sample alert in the group.');
    return;
  }
  fail(`Telegram refused it (HTTP ${status}${reason ? `: ${reason}` : ''}).`);
}

await main();
