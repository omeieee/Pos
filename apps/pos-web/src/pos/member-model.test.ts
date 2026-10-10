import { describe, expect, test } from 'vitest';
import { memberView } from './member-model.ts';

// Made-up details only.
const member = {
  fullName: 'สมมติ ตัวอย่าง',
  nickname: 'ตัวอย่าง',
  building: 'อาคาร ทดสอบ',
  phone: '0800000000',
};

describe('memberView', () => {
  test('nickname first, then the name, then the building', () => {
    expect(memberView(member, 'cashier')?.who).toBe('ตัวอย่าง · สมมติ ตัวอย่าง · อาคาร ทดสอบ');
  });

  test('leaves out what the customer did not give', () => {
    expect(memberView({ ...member, nickname: null, building: ' ' }, 'owner')?.who).toBe(
      'สมมติ ตัวอย่าง',
    );
  });

  test('cashier, manager and owner see the phone; the kitchen and an unknown role never do', () => {
    for (const role of ['cashier', 'manager', 'owner'] as const) {
      expect(memberView(member, role)?.phone).toBe('0800000000');
    }
    expect(memberView(member, 'kitchen')?.phone).toBeNull();
    expect(memberView(member, undefined)?.phone).toBeNull();
    // The kitchen still learns who it is for.
    expect(memberView(member, 'kitchen')?.who).toContain('ตัวอย่าง');
  });

  test('is nothing when there are no details', () => {
    expect(memberView(null, 'owner')).toBeNull();
    expect(memberView(undefined, 'owner')).toBeNull();
    expect(
      memberView({ fullName: null, nickname: null, building: null, phone: null }, 'owner'),
    ).toBeNull();
    // Only a phone, seen by the kitchen: nothing to show.
    expect(
      memberView(
        { fullName: null, nickname: null, building: null, phone: '0800000000' },
        'kitchen',
      ),
    ).toBeNull();
  });
});
