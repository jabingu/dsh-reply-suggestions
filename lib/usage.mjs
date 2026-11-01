import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { USAGE_COUNTERS, USAGE_PERIODS, validateUsageSnapshot } from './common.mjs';
import { estimateCost, priceProfile, PRICE_SOURCE, PRICE_CHECKED_AT, validPriceSnapshot } from './pricing.mjs';
import { billingTier, BILLING_RULE, HOLIDAY_YEARS } from './billing-calendar.mjs';

const statuses = new Set(['complete', 'failed', 'cancelled']);
function validEvent(event) {
  return event?.version === 1 && typeof event.id === 'string' && event.id.length <= 80
    && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && statuses.has(event.status)
    && (event.startedAt === undefined ? event.billingTier === undefined && event.billingRule === undefined
      : typeof event.startedAt === 'string' && Number.isFinite(Date.parse(event.startedAt))
        && typeof event.billingRule === 'string' && event.billingRule.trim() && event.billingRule.length <= 80
        && [null, 'offPeak', 'peak'].includes(event.billingTier))
    && (event.priceSnapshot === undefined || event.priceSnapshot === null || validPriceSnapshot(event.priceSnapshot))
    && ([event.provider, event.model, event.priceProfile].every(value => value === undefined)
      || ([event.provider, event.model].every(value => typeof value === 'string' && value.trim() && value.length <= 512)
        && (event.priceProfile === null || (typeof event.priceProfile === 'string' && event.priceProfile.length <= 80))))
    && (event.usage === null || (event.usage && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
      .every(key => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0)
      && event.usage.inputTokens + event.usage.outputTokens === event.usage.totalTokens));
}

export function summarizeUsage(events, { now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  persistent = true, unreadableRecords = 0, pricing = { currency: 'CNY', checkedAt: PRICE_CHECKED_AT, source: PRICE_SOURCE } } = {}) {
  const formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = date => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = dateKey(now);
  const dayOffset = days => new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  const yesterday = dayOffset(1), weekStart = dayOffset(6), monthStart = dayOffset(29);
  const emptyPeriod = id => ({ id, ...Object.fromEntries(USAGE_COUNTERS.map(key => [key, 0])),
    cost: { cny: 0, minCny: 0, maxCny: 0, pricedRequests: 0, assumedRequests: 0, unpricedRequests: 0, legacyTimeRequests: 0 } });
  const periods = USAGE_PERIODS.map(emptyPeriod);
  const lifetime = emptyPeriod('all');
  const seen = new Set();
  let trackingSince = null;
  for (const event of events) {
    if (!validEvent(event)) { unreadableRecords++; continue; }
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const at = event.startedAt ?? event.at;
    if (Date.parse(at) > now.getTime()) continue;
    if (!trackingSince || Date.parse(at) < Date.parse(trackingSince)) trackingSince = at;
    const key = dateKey(new Date(at));
    const matches = [key === today, key === yesterday, key >= weekStart && key <= today, key >= monthStart && key <= today, true];
    const estimate = estimateCost(event);
    [...periods, lifetime].forEach((period, i) => {
      if (!matches[i]) return;
      period.requests++;
      if (estimate) {
        period.cost.minCny += estimate.minCny; period.cost.maxCny += estimate.maxCny;
        period.cost.cny += estimate.cny;
        if (estimate.timeAssumed) period.cost.legacyTimeRequests++;
        period.cost.pricedRequests++; if (estimate.assumed) period.cost.assumedRequests++;
      } else period.cost.unpricedRequests++;
      if (event.status === 'failed') period.failedRequests++;
      if (event.status === 'cancelled') period.cancelledRequests++;
      if (!event.usage) period.unknownRequests++;
      else for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) period[key] += event.usage[key];
    });
  }
  return validateUsageSnapshot({ timeZone, updatedAt: now.toISOString(), trackingSince, persistent, unreadableRecords, periods, lifetime,
    pricing: { ...pricing, holidayYears: [...HOLIDAY_YEARS] } });
}

// Append-only facts avoid overwriting another desktop/profile process's usage. No conversation text is stored.
export function createUsageStore(file, { clock = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  warn = () => {}, io = { appendFile, mkdir, readFile }, prices } = {}) {
  const pending = new Map();
  let queue = Promise.resolve();
  let warned = false;
  const warning = error => { if (!warned) { warned = true; warn(error); } };
  return {
    requestTime: () => clock().toISOString(),
    ...(prices ? { quote: (provider, model) => prices.quote(provider, model) } : {}),
    async record({ usage, status, provider, model, priceSnapshot, startedAt }) {
      const event = { version: 1, id: randomUUID(), at: clock().toISOString(), status, usage };
      if (startedAt !== undefined) Object.assign(event, { startedAt, billingTier: billingTier(startedAt), billingRule: BILLING_RULE });
      if (provider !== undefined || model !== undefined) Object.assign(event, { provider, model, priceProfile: priceProfile(provider, model) });
      if (priceSnapshot !== undefined) { event.priceSnapshot = priceSnapshot; event.priceProfile = priceSnapshot?.id ?? null; }
      if (!validEvent(event)) throw new TypeError('Invalid usage event');
      pending.set(event.id, event);
      queue = queue.then(async () => {
        const batch = [...pending.values()];
        if (!batch.length) return;
        try {
          await io.mkdir(dirname(file), { recursive: true });
          // Leading newline isolates a new record from an interrupted prior append.
          await io.appendFile(file, '\n' + batch.map(value => JSON.stringify(value)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
          for (const value of batch) pending.delete(value.id);
          warned = false;
        } catch (error) { warning(error); }
      });
      await queue;
    },
    async snapshot() {
      await queue;
      let contents = ''; let readable = true; let unreadableRecords = 0;
      try { contents = await io.readFile(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') { readable = false; warning(error); } }
      const events = [];
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { unreadableRecords++; }
      }
      events.push(...pending.values());
      return summarizeUsage(events, { now: clock(), timeZone, persistent: readable && pending.size === 0, unreadableRecords,
        ...(prices ? { pricing: await prices.status() } : {}) });
    },
  };
}
