/**
 * Who a transfer slip says the money went to, compared with the shop's PromptPay ID (D-26). Pure;
 * no I/O. The ID is passed in by the caller (it comes from settings, never from code).
 *
 * This is only a HINT for staff (CLAUDE.md rule 2): it never confirms or rejects a payment. Banks
 * print the receiver masked (`xxx-xxx-4567`, `xxx-x-x1234-x`) and OCR makes mistakes, so the answer
 * is deliberately cautious:
 * - `match` needs every visible digit to agree with the ID at its position, and at least
 *   {@link MIN_INFORMATIVE} visible digits that are not the common leading ones (a phone's `08`):
 *   four digits are a 1-in-10,000 coincidence for another person, while two or three are not.
 * - `mismatch` needs the same kind of evidence the other way: at least {@link MIN_INFORMATIVE}
 *   informative visible digits and at least {@link MIN_CONFLICTS} of them in conflict, so one misread
 *   digit cannot flag a genuine slip.
 * - everything else is `unknown`: no receiver block, a hidden number, a bank account number (a
 *   different thing from a phone or ID, so it cannot be compared), a shape that does not fit, or two
 *   numbers that disagree.
 * Only the receiver's block is read. The sender's masked number (after จาก / From / ผู้โอน) is never
 * compared. The receiver's NAME is not compared. Nothing of the text is returned: only the word.
 */

export const SLIP_RECIPIENT_CHECKS = ['match', 'mismatch', 'unknown'] as const;
export type SlipRecipientCheck = (typeof SLIP_RECIPIENT_CHECKS)[number];

/** The shop's PromptPay ID, as settings hold it. */
export interface SlipRecipientTarget {
  idType: 'phone' | 'national_id' | 'ewallet';
  idValue: string;
}

/** Visible digits (past the common leading ones) needed before the answer is more than `unknown`. */
export const MIN_INFORMATIVE = 4;
/** Visible digits in conflict needed for `mismatch`; one could be an OCR slip. */
export const MIN_CONFLICTS = 2;
/** The label line and the lines after it that still belong to that person. */
const BLOCK_LINES = 5;
const MAX_TEXT = 8000;

/**
 * What a masked number of each ID type looks like: its length, the usual hyphen groups, and how many
 * leading digits are too common to count as evidence (a phone starts `08`, `09` or `06`; the others
 * are a conservative guess).
 */
const SHAPES: Record<
  SlipRecipientTarget['idType'],
  { length: number; groups: readonly number[] | null; skip: number }
> = {
  phone: { length: 10, groups: [3, 3, 4], skip: 2 },
  national_id: { length: 13, groups: [1, 4, 5, 2, 1], skip: 1 },
  ewallet: { length: 15, groups: null, skip: 3 },
};

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toAsciiDigits = (text: string): string =>
  text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));

const RECEIVER_WORDS = 'ไปยัง|ผู้รับ|ถึง|to|receiver|recipient|payee|biller|beneficiary';
const SENDER_WORDS = 'จาก|ผู้โอน|ผู้ส่ง|ผู้จ่าย|from|sender|payer';
/** Fields that end a block: the amount, the fee, the reference, the memo, the date. */
const NEUTRAL_WORDS =
  'จำนวน|ค่าธรรมเนียม|ค่าบริการ|รหัสอ้างอิง|เลขที่อ้างอิง|หมายเลขอ้างอิง|เลขที่รายการ|หมายเลขรายการ|รหัสรายการ|บันทึก|วันที่|เวลา|สถานะ|amount|fee|ref|reference|transaction|memo|note|date|time|status';

// A label opens a line (Thai words may be glued to the name that follows; English ones may not).
const START_RECEIVER = new RegExp(`^(?:${RECEIVER_WORDS})(?![A-Za-z])`, 'iu');
const START_SENDER = new RegExp(`^(?:${SENDER_WORDS})(?![A-Za-z])`, 'iu');
const START_NEUTRAL = new RegExp(`^(?:${NEUTRAL_WORDS})(?![A-Za-z])`, 'iu');
// A label in the middle of a line only counts as a whole word. It never opens a block; it only shows
// that two people share one line (a merged column), which is then not read at all.
const ANY_RECEIVER = new RegExp(`(?<![\\p{L}\\p{N}])(?:${RECEIVER_WORDS})(?![\\p{L}\\p{N}])`, 'iu');
const ANY_SENDER = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SENDER_WORDS})(?![\\p{L}\\p{N}])`, 'iu');

/** A run of digits and mask characters (x, *, bullets), joined by single hyphens or spaces. */
const NUMBER =
  /(?<![\p{L}\p{N}])\+?[0-9xX×*•●✱](?:[0-9xX×*•●✱]|[ \-–—]+(?=[0-9xX×*•●✱]))*(?![\p{L}\p{N}])/gu;
const SEPARATORS = /[ \-–—]+/;
const MASK = /[xX×*•●✱]/g;

/** The number as `0-9` and `?` (hidden) per position, or null when it cannot be this ID type's. */
function shapeOf(raw: string, idType: SlipRecipientTarget['idType']): string | null {
  const shape = SHAPES[idType];
  let groups = raw.split(SEPARATORS).filter((group) => group !== '');
  let prefix = '';
  if (raw.startsWith('+')) {
    // +66 8x xxx 4567: the country code replaces the leading 0 of a phone.
    if (idType !== 'phone' || groups[0] !== '+66') return null;
    groups = groups.slice(1);
    const lengths = groups.map((group) => group.length);
    if (groups.length === 1 ? lengths[0] !== 9 : lengths.join() !== '2,3,4') return null;
    prefix = '0';
  }
  const compact = prefix + groups.join('').replace(MASK, '?');
  if (compact.length !== shape.length) return null;
  // Unseparated or unknown grouping: only a masked one is a phone/ID (a bare digit string may be a reference).
  if (shape.groups === null || groups.length === 1) return compact.includes('?') ? compact : null;
  if (prefix !== '') return compact;
  return groups.map((group) => group.length).join() === shape.groups.join() ? compact : null;
}

type Verdict = 'match' | 'mismatch' | 'undetermined';

function judge(compact: string, target: SlipRecipientTarget): Verdict {
  const skip = SHAPES[target.idType].skip;
  let informative = 0;
  let conflicts = 0;
  for (let i = 0; i < compact.length; i += 1) {
    const digit = compact[i];
    if (digit === undefined || digit === '?') continue;
    if (i >= skip) informative += 1;
    if (digit !== target.idValue[i]) conflicts += 1;
  }
  if (informative < MIN_INFORMATIVE) return 'undetermined';
  if (conflicts === 0) return 'match';
  return conflicts >= MIN_CONFLICTS ? 'mismatch' : 'undetermined';
}

/** The numbers printed in the receiver's block, lines in order. */
function receiverNumbers(text: string): string[] {
  const lines = toAsciiDigits(text.slice(0, MAX_TEXT)).split(/\r?\n/);
  const found: string[] = [];
  let role: 'receiver' | 'sender' | null = null;
  let left = 0;
  for (const line of lines) {
    const head = line.replace(/^[^\p{L}\p{N}]+/u, '');
    const receiver = START_RECEIVER.test(head) || ANY_RECEIVER.test(head);
    const sender = START_SENDER.test(head) || ANY_SENDER.test(head);
    if (receiver && sender) {
      role = null; // two people on one line: do not guess whose number is whose
      continue;
    }
    if (START_RECEIVER.test(head)) {
      role = 'receiver';
      left = BLOCK_LINES;
    } else if (START_SENDER.test(head)) {
      role = 'sender';
      left = BLOCK_LINES;
    } else if (START_NEUTRAL.test(head)) {
      role = null;
    } else {
      left -= 1;
      if (left <= 0) role = null;
    }
    if (role === 'receiver') found.push(...(line.match(NUMBER) ?? []));
  }
  return found;
}

/** Whether the receiver on the slip is the shop's PromptPay ID (see the file comment for the rules). */
export function checkSlipRecipient(text: string, target: SlipRecipientTarget): SlipRecipientCheck {
  const verdicts: Verdict[] = [];
  for (const raw of receiverNumbers(text)) {
    const compact = shapeOf(raw, target.idType);
    if (compact !== null) verdicts.push(judge(compact, target));
  }
  if (verdicts.length === 0) return 'unknown';
  if (verdicts.every((verdict) => verdict === 'match')) return 'match';
  if (verdicts.every((verdict) => verdict === 'mismatch')) return 'mismatch';
  return 'unknown';
}
