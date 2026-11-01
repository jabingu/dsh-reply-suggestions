import test from 'node:test';
import assert from 'node:assert/strict';
import { billingTier, BILLING_RULE } from '../src/billing-calendar.mjs';
import { BUILTIN_RATES, estimateCost } from '../src/pricing.mjs';
import { summarizeUsage, createUsageStore } from '../src/usage.mjs';
import { createRecommender } from '../src/engine.mjs';
import { validateUsageSnapshot } from '../src/common.mjs';

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110 };
const fact = (at, extra = {}) => ({ version: 1, id: at, at, status: 'complete', usage,
  provider: 'deepseek', model: 'deepseek-flash', priceProfile: BUILTIN_RATES.flash.id,
  priceSnapshot: structuredClone(BUILTIN_RATES.flash), ...extra });
const memoryIO = () => { let contents = ''; return { async mkdir() {}, async readFile() { return contents; },
  async appendFile(_file, text) { contents += text; }, get contents() { return contents; } }; };

test('Beijing peak windows have exact inclusive starts and exclusive ends', () => {
  for (const [time, expected] of [['08:59:59.999', 'offPeak'], ['09:00:00', 'peak'], ['11:59:59.999', 'peak'],
    ['12:00:00', 'offPeak'], ['13:59:59.999', 'offPeak'], ['14:00:00', 'peak'],
    ['17:59:59.999', 'peak'], ['18:00:00', 'offPeak']]) {
    assert.equal(billingTier(`2026-10-14T${time}+08:00`), expected, time);
  }
  assert.equal(billingTier('2026-10-14T01:00:00Z'), 'peak');
  assert.equal(billingTier('2026-10-13T18:00:00-07:00'), 'peak');
});

test('All published 2026 holiday periods and weekend makeup workdays stay off-peak', () => {
  for (const day of ['01-02', '02-16', '02-23', '04-06', '05-04', '05-05', '06-19', '09-25', '10-01', '10-07', '10-10']) {
    assert.equal(billingTier(`2026-${day}T10:00:00+08:00`), 'offPeak', day);
  }
  assert.equal(billingTier('2026-10-08T10:00:00+08:00'), 'peak');
  assert.equal(billingTier('2026-11-01T10:00:00+08:00'), 'offPeak');
});

test('Unknown holiday years are unknown only when the holiday decision affects the rate', () => {
  assert.equal(billingTier('2027-01-04T10:00:00+08:00'), null);
  assert.equal(billingTier('2027-01-04T08:00:00+08:00'), 'offPeak');
  assert.equal(billingTier('2027-01-03T10:00:00+08:00'), 'offPeak');
  assert.equal(billingTier('invalid'), null);
});

test('Each request uses its own tier and frozen rates, independent of the present date', () => {
  const peak = fact('2026-10-14T02:00:00Z');
  const holiday = fact('2026-10-05T02:00:00Z');
  holiday.priceSnapshot.offPeak.input = 3;
  holiday.priceSnapshot.peak.input = 7;
  assert.equal(estimateCost(peak).cny, 0.00028);
  assert.equal(estimateCost(holiday).cny, 0.00034);
  const summary = summarizeUsage([peak, holiday], { now: new Date('2026-11-01T10:00:00Z'), timeZone: 'America/New_York' });
  assert.ok(Math.abs(summary.lifetime.cost.cny - 0.00062) < 1e-12);
  assert.equal(summary.lifetime.cost.minCny, summary.lifetime.cost.maxCny);
});

test('Started requests crossing a rate boundary keep the dispatch time and tier after reload', async () => {
  let at = new Date('2026-10-14T00:59:59.900Z');
  const io = memoryIO();
  const store = createUsageStore('usage', { io, clock: () => at, timeZone: 'UTC', prices: {
    quote: async () => structuredClone(BUILTIN_RATES.flash),
    status: async () => ({ currency: 'CNY', checkedAt: '2026-10-14', source: BUILTIN_RATES.flash.source }),
  } });
  const recommend = createRecommender({ async *stream() {
    at = new Date('2026-10-14T01:00:05Z'); yield { type: 'usage', usage };
  } }, {}, store);
  await recommend({ sessionId: 'test', replyId: 'one', provider: 'deepseek', model: 'deepseek-flash', user: 'PRIVATE', assistant: 'PRIVATE' });
  const saved = JSON.parse(io.contents.trim());
  assert.equal(saved.startedAt, '2026-10-14T00:59:59.900Z'); assert.equal(saved.at, at.toISOString());
  assert.equal(saved.billingTier, 'offPeak'); assert.equal(saved.billingRule, BILLING_RULE);
  assert.equal(estimateCost(saved).cny, 0.00014); assert.equal(estimateCost(saved).timeAssumed, false);
  assert.equal(io.contents.includes('PRIVATE'), false);
  const restored = await createUsageStore('usage', { io, clock: () => at }).snapshot();
  assert.equal(restored.lifetime.cost.cny, 0.00014); assert.equal(restored.lifetime.cost.legacyTimeRequests, 0);
});

test('A request crossing midnight belongs to its dispatch day rather than completion day', () => {
  const start = '2026-10-14T15:59:59Z', end = '2026-10-14T16:00:05Z';
  const event = fact(end, { startedAt: start, billingTier: 'offPeak', billingRule: BILLING_RULE });
  const result = summarizeUsage([event], { now: new Date(end), timeZone: 'Asia/Shanghai' });
  assert.equal(result.periods[0].requests, 0); assert.equal(result.periods[1].requests, 1);
  assert.equal(result.trackingSince, start);
});

test('Legacy facts are recalculated from saved completion time without rewriting their bytes', () => {
  const old = fact('2026-10-14T02:00:00Z'), before = JSON.stringify(old);
  const result = summarizeUsage([old], { now: new Date('2026-11-01T00:00:00Z'), timeZone: 'UTC' });
  assert.equal(result.lifetime.cost.cny, 0.00028); assert.equal(result.lifetime.cost.legacyTimeRequests, 1);
  assert.equal(JSON.stringify(old), before);
});

test('Missing calendars, prices and usage produce partial known amounts rather than invented zero-cost requests', () => {
  const unknown = fact('2027-01-04T02:00:00Z');
  const result = summarizeUsage([unknown, fact('2026-10-14T02:00:00Z')], { now: new Date('2027-01-05T00:00:00Z') });
  assert.equal(estimateCost(unknown), null);
  assert.equal(result.lifetime.cost.cny, 0.00028); assert.equal(result.lifetime.cost.unpricedRequests, 1);
  assert.equal(result.lifetime.cost.pricedRequests, 1); assert.equal(result.lifetime.requests, 2);
});

test('Saved valid tier decisions remain stable while unknown tiers can use a newly covered calendar', () => {
  const at = '2027-01-04T02:00:00Z';
  assert.equal(estimateCost(fact(at, { startedAt: at, billingRule: BILLING_RULE, billingTier: 'offPeak' })).cny, 0.00014);
  const covered = '2026-10-14T02:00:00Z';
  assert.equal(estimateCost(fact(covered, { startedAt: covered, billingRule: BILLING_RULE, billingTier: null })).cny, 0.00028);
});

test('RPC validation rejects inconsistent scalar totals and impossible historical-time counters', () => {
  const snapshot = summarizeUsage([fact('2026-10-14T02:00:00Z')], { now: new Date('2026-10-15T00:00:00Z') });
  for (const change of [{ cny: -1 }, { cny: NaN }, { cny: 999 }, { legacyTimeRequests: 2 }]) {
    assert.throws(() => validateUsageSnapshot({ ...snapshot, lifetime: { ...snapshot.lifetime,
      cost: { ...snapshot.lifetime.cost, ...change } } }));
  }
});

test('Unknown saved billing-rule versions preserve tokens and mark cost unknown', () => {
  const at = '2026-10-14T02:00:00Z';
  const event = fact(at, { startedAt: at, billingRule: 'future-rule', billingTier: 'peak' });
  const result = summarizeUsage([event], { now: new Date('2026-10-15T00:00:00Z') });
  assert.equal(result.unreadableRecords, 0); assert.equal(result.lifetime.totalTokens, 110);
  assert.equal(result.lifetime.cost.unpricedRequests, 1);
});
