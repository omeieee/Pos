/**
 * Writes an HTML page of PromptPay QR codes for the manual bank-app scan test
 * (P1 exit criterion). Usage: node scripts/scan-test.ts <out.html> <promptpay-phone>
 * Scan each code in the bank app WITHOUT paying and note the name and amount shown.
 */
import { writeFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { promptpayPayload } from '../src/payload.ts';

const out = process.argv[2];
// The PromptPay ID is never hardcoded (CLAUDE.md rule 3); pass the one from settings.
const phone = process.argv[3];
if (!out || !phone || !/^0\d{9}$/.test(phone)) {
  throw new Error('usage: node scripts/scan-test.ts <out.html> <promptpay-phone, 10 digits>');
}

const amounts = [100, 4550, 7500, 12000, 99999];
const cards: string[] = [];
for (const amount of amounts) {
  // biome-ignore lint/suspicious/noExplicitAny: Satang brand is irrelevant in this dev script.
  const payload = promptpayPayload({ idType: 'phone', idValue: phone }, amount as any);
  // PNG, black on white, with a 4-module quiet zone: bank apps failed to read the SVG version.
  const png = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 10,
    color: { dark: '#000000', light: '#ffffff' },
  });
  const baht = (amount / 100).toFixed(2);
  cards.push(
    `<figure><img class="qr" src="${png}" alt="PromptPay QR ${baht} baht"><figcaption><b>฿${baht}</b><br><code>${payload}</code></figcaption></figure>`,
  );
}

writeFileSync(
  out,
  `<!doctype html><meta charset="utf-8"><title>PromptPay scan test</title>
<style>html{color-scheme:light}body{font-family:system-ui,sans-serif;margin:24px;background:#fff;color:#111}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px}
figure{margin:0;border:1px solid #ccc;border-radius:12px;padding:16px;text-align:center}
.qr{width:300px;height:300px;image-rendering:pixelated}code{font-size:10px;word-break:break-all}b{font-size:28px}</style>
<h1>PromptPay scan test (${phone.slice(0, 3)}-xxx-${phone.slice(-4)})</h1>
<p>Scan with K PLUS. Do NOT pay. For each: does the app show the right recipient name and exactly this amount, with the amount locked?</p>
<main>${cards.join('\n')}</main>`,
);
console.log(`wrote ${out}`);
