import type { expensesRepo } from '@sds/db';
import { type ExpenseDto, satang } from '@sds/shared';

export function toExpenseDto(row: expensesRepo.ExpenseRow): ExpenseDto {
  return {
    id: row.id,
    businessDate: row.businessDate,
    category: row.category,
    amountSatang: satang(row.amountSatang),
    vendor: row.vendor,
    note: row.note,
    receiptImageKey: row.receiptImageKey,
    createdByStaffId: row.createdByStaffId,
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidReason: row.voidReason,
    version: row.version,
    rev: row.rev,
  };
}
