/**
 * The bank's transaction reference printed on a transfer slip, read from OCR text (D-26). Pure; no
 * I/O. Two payments that carry the same reference came from the same transfer, so it is used to
 * HINT that a slip was used twice. It is only a hint: staff still confirm from the bank app
 * (CLAUDE.md rule 2). When the text is not clear the answer is null, never a guess.
 */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toAsciiDigits = (text: string): string =>
  text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));

/** รหัสอ้างอิง, เลขที่รายการ, Ref No., Transaction ID ... as the Thai banks print them. */
const LABEL =
  /รหัสอ้างอิง|เลขที่อ้างอิง|หมายเลขอ้างอิง|เลขที่รายการ|หมายเลขรายการ|รหัสรายการ|\btransaction\s*(?:id|no|number|ref(?:erence)?)\b|\bref(?:erence)?\b(?:\s*(?:no|number|id|code)\b)?/gi;
/** Between a label and its value: spaces, colon, dots, slashes, hash. */
const SEPARATORS = /^[\s:：.#/|-]*/;
/** A reference: letters and digits, hyphens allowed inside (dropped). At least 10 characters. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]/;
const WHOLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/;
const MIN_LENGTH = 10;
const MAX_LENGTH = 40;
/** A reference has digits in it; a plain word (or an amount, which has a dot) is not one. */
const MIN_DIGITS = 6;

/** Upper case, no hyphens; null when it does not look like a reference. */
export function normaliseSlipRef(raw: string): string | null {
  const ref = raw.replaceAll('-', '').toUpperCase();
  if (ref.length < MIN_LENGTH || ref.length > MAX_LENGTH) return null;
  if ((ref.match(/\d/g) ?? []).length < MIN_DIGITS) return null;
  return ref;
}

/**
 * The reference, upper case without hyphens, or null when the text has none or more than one
 * different one. The value is the token right after a label on the same line, or the whole next
 * line when the label stands alone.
 */
export function extractSlipRef(text: string): string | null {
  const lines = toAsciiDigits(text).split(/\r?\n/);
  const found = new Set<string>();

  lines.forEach((line, index) => {
    const labels = [...line.matchAll(LABEL)];
    labels.forEach((label, n) => {
      const start = (label.index ?? 0) + label[0].length;
      const stop = labels[n + 1]?.index ?? line.length;
      const rest = line.slice(start, stop).replace(SEPARATORS, '');
      if (rest.trim() === '') {
        // Another label follows on this line ("รหัสอ้างอิง / Ref ID: ..."): the value belongs to that one.
        if (labels[n + 1]) return;
        const next = (lines[index + 1] ?? '').trim();
        if (WHOLE_TOKEN.test(next)) {
          const ref = normaliseSlipRef(next);
          if (ref) found.add(ref);
        }
        return;
      }
      const token = TOKEN.exec(rest)?.[0];
      // A value that goes on after the token with a dot or a digit (60.00) is an amount, not a ref.
      if (!token || /^[.,]\d/.test(rest.slice(token.length))) return;
      const ref = normaliseSlipRef(token);
      if (ref) found.add(ref);
    });
  });

  return found.size === 1 ? ([...found][0] ?? null) : null;
}
