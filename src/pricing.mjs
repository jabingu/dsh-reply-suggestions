import { billingTier, BILLING_RULE } from './billing-calendar.mjs';
// Official CNY prices checked 2026-10-14. Keep versioned tables when adding future rates.
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
export const PRICE_CHECKED_AT = '2026-10-14';
const FLASH = 'deepseek-flash-cny-2026-10-14';
const PRO = 'deepseek-pro-cny-2026-10-14';
const profiles = {
  [FLASH]: { from: '2026-09-10T04:00:00Z', input: 1, cache: 0.02, output: 4 },
  [PRO]: { from: '2026-08-16T16:00:00Z', input: 4.5, cache: 0.15, output: 13.5 },
};
export function modelFamily(provider, model) {
  if (!['deepseek', 'deepseek-account'].includes(provider)) return null;
  if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return 'flash';
  if (model === 'deepseek-v4-pro') return 'pro';
  return null;
}
export function priceProfile(provider, model) {
  return { flash: FLASH, pro: PRO }[modelFamily(provider, model)] ?? null;
}
export const BUILTIN_RATES = Object.fromEntries([['flash', FLASH], ['pro', PRO]].map(([key, id]) => {
  const rate = profiles[id];
  return [key, { id, modelKey: key, currency: 'CNY', source: PRICE_SOURCE, checkedAt: PRICE_CHECKED_AT,
    from: rate.from, offPeak: { input: rate.input, cache: rate.cache, output: rate.output },
    peak: { input: rate.input * 2, cache: rate.cache * 2, output: rate.output * 2 } }];
}));
export function validPriceSnapshot(value) {
  return Boolean(value && ['flash', 'pro'].includes(value.modelKey) && value.currency === 'CNY'
    && value.source === PRICE_SOURCE && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 80
    && typeof value.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.checkedAt)
    && typeof value.from === 'string' && Number.isFinite(Date.parse(value.from))
    && ['input', 'cache', 'output'].every(key => Number.isFinite(value.offPeak?.[key]) && value.offPeak[key] >= 0
      && value.offPeak[key] <= 1e6 && Number.isFinite(value.peak?.[key]) && value.peak[key] >= value.offPeak[key]
      && value.peak[key] <= 1e6));
}
export function estimateCost(event) {
  if (!event.usage) return null;
  const assumed = event.provider === undefined && event.model === undefined && event.priceProfile === undefined;
  let snapshot = event.priceSnapshot;
  if (snapshot !== undefined) {
    if (!validPriceSnapshot(snapshot) || snapshot.modelKey !== modelFamily(event.provider, event.model)) return null;
  } else {
    const id = assumed ? FLASH : event.priceProfile;
    snapshot = Object.values(BUILTIN_RATES).find(value => value.id === id);
  }
  const at = event.startedAt ?? event.at;
  if (!snapshot || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(snapshot.from)) return null;
  if (event.startedAt !== undefined && event.billingRule !== BILLING_RULE) return null;
  const tier = event.startedAt !== undefined && event.billingRule === BILLING_RULE
    && ['offPeak', 'peak'].includes(event.billingTier) ? event.billingTier : billingTier(at);
  if (!tier) return null;
  const { inputTokens, outputTokens, cacheReadTokens } = event.usage;
  if (cacheReadTokens > inputTokens) return null;
  const rate = snapshot[tier];
  const cny = ((inputTokens - cacheReadTokens) * rate.input
    + cacheReadTokens * rate.cache + outputTokens * rate.output) / 1e6;
  return { cny, minCny: cny, maxCny: cny, tier, assumed, timeAssumed: event.startedAt === undefined };
}
