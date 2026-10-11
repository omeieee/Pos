/**
 * The small QR on a Thai bank transfer slip (the "slip verify" mini QR, D-26), read as text by the
 * API. Pure; no I/O. It is a TLV list (2-digit tag, 2-digit length, value) like an EMVCo payload:
 * one tag holds a nested list with 00 = API id (6 digits, 000001), 01 = sending bank code (3
 * digits) and 02 = the bank's transaction reference; a country tag and a CRC (tag 91) may follow.
 * Two slips with the same sending bank and reference are the same transfer, so the pair is a
 * duplicate key (a screenshot or a re-photo carries the same QR). It is only a HINT for staff
 * (CLAUDE.md rule 2): it proves nothing about funds, and a fake slip can print any QR.
 *
 * Only the layout "API id, bank, reference [, country] [, CRC]" is known from public
 * documentation; banks may differ in details, so this reads by tag and refuses anything it cannot
 * read exactly (null, never a guess). The CRC is checked when one is present, because a misread QR
 * must not make a key.
 */
import { normaliseSlipRef } from './slip-ref.ts';

export interface SlipQr {
  /** The sending bank's 3-digit code. */
  sendingBank: string;
  /** The transaction reference, normalised like the printed one (upper case, no hyphens). */
  transRef: string;
}

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR) as 4 upper-case hex
 * digits: the EMVCo CRC. A small copy of the one in `@sds/promptpay`, which depends on this
 * package and so cannot be imported here; the test pins the standard check value.
 */
export function crc16Ccitt(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

interface Field {
  tag: string;
  value: string;
  /** Where the field starts in the text it was read from. */
  at: number;
}

/** The whole text as fields, or null when any length is wrong or anything is left over. */
function readFields(text: string): Field[] | null {
  const fields: Field[] = [];
  let at = 0;
  while (at < text.length) {
    const head = text.slice(at, at + 4);
    if (!/^\d{4}$/.test(head)) return null;
    const length = Number(head.slice(2));
    const value = text.slice(at + 4, at + 4 + length);
    if (value.length !== length) return null;
    fields.push({ tag: head.slice(0, 2), value, at });
    at += 4 + length;
  }
  return fields;
}

/** A nested list that is a slip-verify block, or null. */
function slipBlock(value: string): SlipQr | null {
  const sub = readFields(value);
  if (!sub) return null;
  const only = (tag: string): string | null => {
    const found = sub.filter((f) => f.tag === tag);
    return found.length === 1 ? (found[0]?.value ?? null) : null;
  };
  const api = only('00');
  const bank = only('01');
  const ref = only('02');
  if (api === null || !/^\d{6}$/.test(api)) return null;
  if (bank === null || !/^\d{3}$/.test(bank)) return null;
  const transRef = ref === null ? null : normaliseSlipRef(ref);
  return transRef ? { sendingBank: bank, transRef } : null;
}

/** The sending bank and reference in the QR text, or null when it is not a readable slip QR. */
export function parseSlipQr(raw: string): SlipQr | null {
  const text = raw.trim();
  const fields = readFields(text);
  if (!fields) return null;
  // A CRC, when there is one, is the last field and covers everything up to and including "9104".
  const crc = fields.find((f) => f.tag === '91');
  if (crc) {
    if (fields[fields.length - 1] !== crc || !/^[0-9A-F]{4}$/i.test(crc.value)) return null;
    if (crc16Ccitt(text.slice(0, crc.at + 4)) !== crc.value.toUpperCase()) return null;
  }
  const found = fields.flatMap((f) => {
    const block = f.tag === '91' ? null : slipBlock(f.value);
    return block ? [block] : [];
  });
  const first = found[0];
  if (!first) return null;
  const same = found.every(
    (b) => b.sendingBank === first.sendingBank && b.transRef === first.transRef,
  );
  return same ? first : null;
}
