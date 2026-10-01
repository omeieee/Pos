import { type Db, getSettingValue } from '@sds/db';
import {
  type BusinessDaySettings,
  businessDate,
  businessDaySettingsSchema,
  DEFAULT_CUTOFF_MINUTES,
  SHOP_TIME_ZONE,
} from '@sds/shared';

/** settings.business_day, or the documented default (04:00 Asia/Bangkok) when it was never saved. */
export async function loadBusinessDay(db: Db): Promise<BusinessDaySettings> {
  const saved = await getSettingValue(db, 'business_day');
  if (saved === undefined) {
    return { cutoffMinutes: DEFAULT_CUTOFF_MINUTES, timeZone: SHOP_TIME_ZONE };
  }
  // A damaged setting fails loudly: guessing a cutoff would put orders on the wrong day.
  return businessDaySettingsSchema.parse(saved);
}

export async function currentBusinessDate(db: Db, now: Date): Promise<string> {
  const day = await loadBusinessDay(db);
  return businessDate(now, day.cutoffMinutes, day.timeZone);
}
