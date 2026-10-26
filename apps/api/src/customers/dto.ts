import type { syncRepo } from '@sds/db';
import { type CustomerDto, customerDtoSchema } from '@sds/shared';

/**
 * The feed's allow-listed customer row to the staff shape (02 §5 `customer.upserted`). Parsing
 * through the shared schema keeps the contract in one place; the row type cannot hold the LINE id,
 * phone, member profile, remembered recipient or slip flag (`syncRepo.SYNC_POLICY`), so neither
 * can the DTO. An erased customer comes out with every name empty and `anonymized: true`.
 */
export function toCustomerDto(row: syncRepo.SyncCustomerRow): CustomerDto {
  return customerDtoSchema.parse({
    id: row.id,
    displayName: row.displayName,
    nickname: row.nickname,
    roomNo: row.roomNo,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
    orderCount: row.orderCount,
    totalSpentSatang: row.totalSpentSatang,
    anonymized: row.anonymizedAt !== null,
    version: row.version,
    rev: row.rev,
  });
}
