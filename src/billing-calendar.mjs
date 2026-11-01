// Official 2026 day-off schedule, State Council notice 国办发明电〔2025〕7号.
// Pricing explicitly makes weekends off-peak, including weekend makeup workdays.
export const HOLIDAY_SOURCE = 'https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html';
export const HOLIDAY_YEARS = [2026];
export const BILLING_RULE = 'deepseek-cn-v1';
const holidays = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

// The tariff uses Beijing time, independently of the Host's calendar-day timezone.
export function billingTier(at) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return null;
  const beijing = new Date(timestamp + 8 * 3600000);
  const day = beijing.getUTCDay(), minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  if (day === 0 || day === 6 || !(minute >= 540 && minute < 720 || minute >= 840 && minute < 1080)) return 'offPeak';
  if (!HOLIDAY_YEARS.includes(beijing.getUTCFullYear())) return null;
  const date = beijing.toISOString().slice(0, 10);
  return holidays.some(([start, end]) => date >= start && date <= end) ? 'offPeak' : 'peak';
}
