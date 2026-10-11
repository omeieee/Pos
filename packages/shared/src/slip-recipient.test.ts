import { describe, expect, test } from 'vitest';
import { checkSlipRecipient, type SlipRecipientCheck } from './slip-recipient.ts';

// Fake IDs only: no real PromptPay ID is ever used in a test.
const PHONE = { idType: 'phone', idValue: '0891234567' } as const;
const NATIONAL = { idType: 'national_id', idValue: '1234567890123' } as const;
const EWALLET = { idType: 'ewallet', idValue: '123456789012345' } as const;

type Id = typeof PHONE | typeof NATIONAL | typeof EWALLET;
const slip = (sender: string, receiver: string) =>
  `โอนเงินสำเร็จ\nจาก\nนาย ทดสอบ ผู้ส่ง\n${sender}\nไปยัง\nนาย ทดสอบ ผู้รับ\n${receiver}\nจำนวน 15.00 บาท\nค่าธรรมเนียม 0.00 บาท`;

describe('checkSlipRecipient: the shop is a phone number (0891234567)', () => {
  const cases: [name: string, text: string, expected: SlipRecipientCheck][] = [
    ['xxx-xxx-4567 after the receiver label', slip('xxx-x-x9999-x', 'xxx-xxx-4567'), 'match'],
    ['upper case X', slip('XXX-X-X9999-X', 'XXX-XXX-4567'), 'match'],
    ['08x-xxx-4567 (prefix and tail shown)', slip('xxx-x-x9999-x', '08x-xxx-4567'), 'match'],
    ['stars as the mask', slip('xxx-x-x9999-x', '***-***-4567'), 'match'],
    ['bullets as the mask', slip('xxx-x-x9999-x', '•••-•••-4567'), 'match'],
    ['spaces instead of hyphens', slip('xxx-x-x9999-x', 'xxx xxx 4567'), 'match'],
    ['no separators, masked', slip('xxx-x-x9999-x', 'xxxxxx4567'), 'match'],
    ['Thai digits', slip('xxx-x-x9999-x', 'xxx-xxx-๔๕๖๗'), 'match'],
    ['fully visible number', slip('xxx-x-x9999-x', '089-123-4567'), 'match'],
    ['+66 form', slip('xxx-x-x9999-x', '+66 8x xxx 4567'), 'match'],
    [
      'English labels From and To',
      'From\nMr Sender\nxxx-xxx-1111\nTo\nMr Shop\nxxx-xxx-4567\nAmount 15.00',
      'match',
    ],
    ['Receiver label', 'Sender\nxxx-xxx-1111\nReceiver\nxxx-xxx-4567', 'match'],
    ['ผู้โอน and ผู้รับ labels', 'ผู้โอน\nxxx-xxx-1111\nผู้รับ\nxxx-xxx-4567', 'match'],
    ['label and number on one line', 'จาก นาย ก xxx-xxx-1111\nไปยัง นาย ข xxx-xxx-4567', 'match'],
    ['a leading arrow before the label', 'จาก\nxxx-xxx-1111\n▼ ไปยัง\nxxx-xxx-4567', 'match'],
    ['a different receiver: tail 8888', slip('xxx-x-x9999-x', 'xxx-xxx-8888'), 'mismatch'],
    [
      'a different receiver with a visible prefix',
      slip('xxx-x-x9999-x', '08x-xxx-8888'),
      'mismatch',
    ],
    ['a different full number', slip('xxx-x-x9999-x', '081-999-8888'), 'mismatch'],
    ['a different +66 number', slip('xxx-x-x9999-x', '+66 8x xxx 8888'), 'mismatch'],
    ['a different Thai-digit tail', slip('xxx-x-x9999-x', 'xxx-xxx-๘๘๘๘'), 'mismatch'],
  ];
  test.each(cases)('%s', (_name, text, expected) => {
    expect(checkSlipRecipient(text, PHONE)).toBe(expected);
  });

  const unknowns: [name: string, text: string][] = [
    ['empty text', ''],
    ['no receiver label at all', 'xxx-xxx-4567\n15.00 บาท'],
    [
      'only the sender is labelled (its number must not be compared)',
      'จาก\nxxx-xxx-4567\n15.00 บาท',
    ],
    [
      'the sender looks like the shop but the receiver is hidden',
      'จาก\nนาย ก\nxxx-xxx-4567\nไปยัง\nนาย ข\nxxx-xxx-xxxx',
    ],
    ['only 3 digits visible', slip('xxx-x-x9999-x', 'xxx-xxx-x567')],
    ['only the prefix visible', slip('xxx-x-x9999-x', '089-xxx-xxxx')],
    ['one conflicting digit (could be an OCR slip)', slip('xxx-x-x9999-x', 'xxx-xxx-4568')],
    [
      'a bank account shape (3-1-5-1) cannot be compared with a phone',
      slip('xxx-x-x9999-x', 'xxx-x-x4567-x'),
    ],
    ['an unseparated all-digit string may be a reference', slip('xxx-x-x9999-x', '0891239999')],
    ['a national ID shape is not a phone', slip('xxx-x-x9999-x', 'x-xxxx-xxx45-67-8')],
    ['groups of the wrong size (OCR lost an x)', slip('xxx-x-x9999-x', 'xx-xxx-8888')],
    ['two receiver numbers that disagree', 'ไปยัง\nxxx-xxx-4567\nxxx-xxx-8888'],
    ['a line with both labels is ignored', 'จาก นาย ก xxx-xxx-1111 ไปยัง นาย ข xxx-xxx-4567'],
    [
      'the number is after the amount label, outside the block',
      'ไปยัง\nนาย ข\nจำนวน 15.00 บาท\nxxx-xxx-8888',
    ],
    ['a far line is outside the block', 'ไปยัง\nนาย ข\nธนาคาร\nสาขา\nข้อมูล\nxxx-xxx-8888'],
  ];
  test.each(unknowns)('unknown: %s', (_name, text) => {
    expect(checkSlipRecipient(text, PHONE)).toBe('unknown');
  });

  test('the sender number equal to the shop is never used (receiver differs from it)', () => {
    // Sender shows the shop's tail; receiver is someone else: the answer is about the receiver.
    expect(checkSlipRecipient(slip('xxx-xxx-4567', 'xxx-xxx-8888'), PHONE)).toBe('mismatch');
  });

  test('the sender number equal to the shop does not make a match when the receiver is hidden', () => {
    expect(checkSlipRecipient(slip('xxx-xxx-4567', 'xxx-xxx-xxxx'), PHONE)).toBe('unknown');
  });

  test('a number after a sender label that follows the receiver block is not the receiver', () => {
    expect(checkSlipRecipient('ไปยัง\nนาย ข\nxxx-xxx-8888\nจาก\nxxx-xxx-4567', PHONE)).toBe(
      'mismatch',
    );
  });
});

describe('checkSlipRecipient: the shop is a national ID (1234567890123)', () => {
  const cases: [name: string, text: string, expected: SlipRecipientCheck][] = [
    ['x-xxxx-xxx90-12-3', slip('xxx-xxx-1111', 'x-xxxx-xxx90-12-3'), 'match'],
    ['only three digits shown is too little', slip('xxx-xxx-1111', 'x-xxxx-xxxxx-12-3'), 'unknown'],
    [
      'an unseparated all-digit string may be a reference',
      slip('xxx-xxx-1111', '1234567890123'),
      'unknown',
    ],
    ['more digits shown', slip('xxx-xxx-1111', '1-23xx-xxx90-12-3'), 'match'],
    ['fully visible', slip('xxx-xxx-1111', '1-2345-67890-12-3'), 'match'],
    ['Thai digits', slip('xxx-xxx-1111', 'x-xxxx-xxx๙๐-๑๒-๓'), 'match'],
    ['another ID', slip('xxx-xxx-1111', 'x-xxxx-xxx55-44-2'), 'mismatch'],
    ['a phone shape is not an ID', slip('xxx-xxx-1111', 'xxx-xxx-9999'), 'unknown'],
  ];
  test.each(cases)('%s', (_name, text, expected) => {
    expect(checkSlipRecipient(text, NATIONAL)).toBe(expected);
  });
});

describe('checkSlipRecipient: the shop is an e-wallet ID', () => {
  test('match on the visible digits', () => {
    expect(checkSlipRecipient(slip('xxx-xxx-1111', 'xxxxxxxxxx12345'), EWALLET)).toBe('match');
  });
  test('mismatch on conflicting digits', () => {
    expect(checkSlipRecipient(slip('xxx-xxx-1111', 'xxxxxxxxxx98765'), EWALLET)).toBe('mismatch');
  });
  test('wrong length is unknown', () => {
    expect(checkSlipRecipient(slip('xxx-xxx-1111', 'xxxxxxxxx12345'), EWALLET)).toBe('unknown');
  });
});

describe('checkSlipRecipient: safety', () => {
  const ids: Id[] = [PHONE, NATIONAL, EWALLET];
  test.each(ids)('never throws on noise ($idType)', (id) => {
    for (const text of [
      '',
      '\n\n',
      'ไปยัง',
      'ไปยัง\n+',
      'ไปยัง\n---',
      ['to', 'x'.repeat(5000)].join('\n'),
      '\u0000',
    ]) {
      expect(['match', 'mismatch', 'unknown']).toContain(checkSlipRecipient(text, id));
    }
  });
  test('the answer is a plain word: it carries none of the text', () => {
    const answer = checkSlipRecipient(slip('xxx-xxx-1111', 'xxx-xxx-4567'), PHONE);
    expect(answer).toBe('match');
  });
});

// Fake account numbers only.
const ACCOUNT = { accountNumber: '1234567890' } as const; // visible tail of xxx-x-x6789-x is 6789
const ACCOUNT12 = { accountNumber: '123456789012' } as const;

describe('checkSlipRecipient: the shop receiving account (1234567890), no PromptPay ID', () => {
  const cases: [name: string, text: string, expected: SlipRecipientCheck][] = [
    ['xxx-x-x6789-x', slip('xxx-x-x1111-x', 'xxx-x-x6789-x'), 'match'],
    ['upper case X', slip('XXX-X-X1111-X', 'XXX-X-X6789-X'), 'match'],
    ['stars', slip('xxx-x-x1111-x', '***-*-*6789-*'), 'match'],
    ['bullets', slip('xxx-x-x1111-x', '•••-•-•6789-•'), 'match'],
    ['spaces instead of hyphens', slip('xxx-x-x1111-x', 'xxx x x6789 x'), 'match'],
    ['Thai digits', slip('xxx-x-x1111-x', 'xxx-x-x๖๗๘๙-x'), 'match'],
    ['a 3-6-1 mask', slip('xxx-x-x1111-x', 'xxx-xxx789-0'), 'match'],
    ['fully visible, grouped', slip('xxx-x-x1111-x', '123-4-56789-0'), 'match'],
    [
      'English labels',
      'From\nMr Sender\nxxx-x-x1111-x\nTo\nMr Shop\nxxx-x-x6789-x\nAmount 15.00',
      'match',
    ],
    ['all visible digits differ', slip('xxx-x-x6789-x', 'xxx-x-x1111-x'), 'mismatch'],
    ['two visible digits differ', slip('xxx-x-x1111-x', 'xxx-x-x6711-x'), 'mismatch'],
    ['another full number', slip('xxx-x-x1111-x', '987-6-54321-0'), 'mismatch'],
  ];
  test.each(cases)('%s', (_name, text, expected) => {
    expect(checkSlipRecipient(text, null, ACCOUNT)).toBe(expected);
  });

  const unknowns: [name: string, text: string][] = [
    ['empty text', ''],
    ['no receiver label', 'xxx-x-x6789-x\n15.00 บาท'],
    ['only the sender is labelled', 'จาก\nxxx-x-x6789-x\n15.00 บาท'],
    ['three digits visible', slip('xxx-x-x1111-x', 'xxx-x-xx789-x')],
    ['one conflicting digit (could be an OCR slip)', slip('xxx-x-x1111-x', 'xxx-x-x6781-x')],
    ['receiver hidden, sender equals the shop', slip('xxx-x-x6789-x', 'xxx-x-xxxxx-x')],
    ['a different length cannot be aligned', slip('xxx-x-x1111-x', 'xxx-x-xx1234-xxx')],
    ['a phone shape is never an account', slip('xxx-x-x1111-x', 'xxx-xxx-6789')],
    ['a masked unseparated 10-digit string may be a phone', slip('xxx-x-x1111-x', 'xxxxxx6789')],
    ['an unseparated all-digit string may be a reference', slip('xxx-x-x1111-x', '1234567890')],
    ['a national ID shape', slip('xxx-x-x1111-x', 'x-xxxx-xxx45-67-8')],
    ['a +66 phone', slip('xxx-x-x1111-x', '+66 8x xxx 6789')],
    ['two receiver numbers that disagree', 'ไปยัง\nxxx-x-x6789-x\nxxx-x-x1111-x'],
  ];
  test.each(unknowns)('unknown: %s', (_name, text) => {
    expect(checkSlipRecipient(text, null, ACCOUNT)).toBe('unknown');
  });

  test('the sender account equal to the shop is never used', () => {
    expect(checkSlipRecipient(slip('xxx-x-x6789-x', 'xxx-x-x1111-x'), null, ACCOUNT)).toBe(
      'mismatch',
    );
    expect(checkSlipRecipient(slip('xxx-x-x6789-x', 'xxx-x-xxxxx-x'), null, ACCOUNT)).toBe(
      'unknown',
    );
  });

  test('a 12-digit account, masked and unseparated', () => {
    expect(checkSlipRecipient(slip('x', 'xxxxxxxx9012'), null, ACCOUNT12)).toBe('match');
    expect(checkSlipRecipient(slip('x', 'xxxxxxxx1111'), null, ACCOUNT12)).toBe('mismatch');
  });

  test('a configured value that is not 10 to 15 digits is ignored', () => {
    const text = slip('xxx-x-x1111-x', 'xxx-x-x6789-x');
    expect(checkSlipRecipient(text, null, { accountNumber: '12345678' })).toBe('unknown');
    expect(checkSlipRecipient(text, null, { accountNumber: '12345-67890' })).toBe('unknown');
  });
});

describe('checkSlipRecipient: PromptPay ID and account together', () => {
  test('an account-shaped receiver is judged against the account, not the phone', () => {
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-x-x6789-x'), PHONE, ACCOUNT)).toBe(
      'match',
    );
    expect(checkSlipRecipient(slip('xxx-x-x6789-x', 'xxx-x-x1111-x'), PHONE, ACCOUNT)).toBe(
      'mismatch',
    );
  });
  test('a phone-shaped receiver is judged against the phone, not the account', () => {
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-xxx-4567'), PHONE, ACCOUNT)).toBe('match');
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-xxx-8888'), PHONE, ACCOUNT)).toBe(
      'mismatch',
    );
    // 6789 is the account tail, not the phone tail: it must not match through the account.
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-xxx-6789'), PHONE, ACCOUNT)).toBe(
      'mismatch',
    );
  });
  test('without an account the old answer stays unknown for an account shape', () => {
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-x-x6789-x'), PHONE)).toBe('unknown');
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-x-x6789-x'), PHONE, null)).toBe('unknown');
  });
  test('a national ID target and an account-shaped receiver', () => {
    expect(checkSlipRecipient(slip('xxx-x-x1111-x', 'xxx-x-x6789-x'), NATIONAL, ACCOUNT)).toBe(
      'match',
    );
  });
  test('an e-wallet target keeps an unseparated 15-digit mask for itself', () => {
    const wallet = { accountNumber: '123456789012345' } as const;
    expect(checkSlipRecipient(slip('x', 'xxxxxxxxxx12345'), EWALLET, wallet)).toBe('match');
  });
  test('no target and no account is unknown', () => {
    expect(checkSlipRecipient(slip('x', 'xxx-x-x6789-x'), null)).toBe('unknown');
  });
  test('never throws on noise', () => {
    for (const text of ['', '\n\n', 'ไปยัง\n+', 'ไปยัง\n---', ['to', 'x'.repeat(5000)].join('\n')]) {
      expect(['match', 'mismatch', 'unknown']).toContain(checkSlipRecipient(text, PHONE, ACCOUNT));
    }
  });
});
