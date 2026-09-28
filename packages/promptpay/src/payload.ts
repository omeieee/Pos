import type { PromptpaySettings, Satang } from '@sds/shared';

/**
 * EMVCo merchant-presented PromptPay QR payload, BOT profile (04-integrations §2.1).
 * Always dynamic (tag 01 = 12) with the exact amount; the target comes from settings.
 */
const GUID_PROMPTPAY = 'A000000677010111';
const TARGET_SUBTAG: Record<PromptpaySettings['idType'], string> = {
  phone: '01',
  national_id: '02',
  ewallet: '03',
};
/** Largest amount tag 54 can hold with our 2-decimal format and sane shop totals: ฿9,999,999.99. */
const MAX_AMOUNT_SATANG = 999_999_999;

export function tlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) throw new RangeError(`bad tag ${tag}`);
  if (value.length > 99) throw new RangeError(`value too long for tag ${tag}`);
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code > 0x7f) throw new RangeError('payload must be ASCII');
    crc ^= code << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTarget(target: PromptpaySettings): string {
  if (target.idType === 'phone') {
    if (!/^0\d{9}$/.test(target.idValue)) throw new RangeError('phone must be 10 digits from 0');
    // 0066 + number without its leading 0 → 13 digits.
    return `0066${target.idValue.slice(1)}`;
  }
  const digits = target.idType === 'national_id' ? 13 : 15;
  if (!new RegExp(`^\\d{${digits}}$`).test(target.idValue)) {
    throw new RangeError(`${target.idType} must be ${digits} digits`);
  }
  return target.idValue;
}

/** Integer satang → "75.00" without floating-point math. */
export function formatAmount(amount: Satang): string {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_SATANG) {
    throw new RangeError(`amount must be 1–${MAX_AMOUNT_SATANG} satang, got ${amount}`);
  }
  const baht = Math.floor(amount / 100);
  const rest = amount % 100;
  return `${baht}.${String(rest).padStart(2, '0')}`;
}

export function promptpayPayload(target: PromptpaySettings, amount: Satang): string {
  const merchant =
    tlv('00', GUID_PROMPTPAY) + tlv(TARGET_SUBTAG[target.idType], formatTarget(target));
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('29', merchant) +
    tlv('53', '764') +
    tlv('54', formatAmount(amount)) +
    tlv('58', 'TH') +
    '6304';
  return body + crc16(body);
}

export interface TlvField {
  tag: string;
  value: string;
}

/** Decodes one TLV level. Throws on malformed input. */
export function decodeTlv(data: string): TlvField[] {
  const fields: TlvField[] = [];
  let i = 0;
  while (i < data.length) {
    const tag = data.slice(i, i + 2);
    const len = Number(data.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(len) || i + 4 + len > data.length) {
      throw new RangeError(`malformed TLV at ${i}`);
    }
    fields.push({ tag, value: data.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return fields;
}

/** True when the payload's tag 63 is last and matches the CRC of everything before it. */
export function hasValidCrc(payload: string): boolean {
  if (payload.length < 8 || payload.slice(-8, -4) !== '6304') return false;
  return crc16(payload.slice(0, -4)) === payload.slice(-4);
}
