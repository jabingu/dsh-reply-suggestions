import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { priceProfile, estimateCost } from '../src/pricing.mjs';
import { createUsageStore, summarizeUsage } from '../src/usage.mjs';
import { createRecommender } from '../src/engine.mjs';
import { formatCost, validateUsageSnapshot } from '../src/common.mjs';

const now = new Date('2026-10-14T03:00:00Z');
const options = { now, timeZone: 'Asia/Shanghai' };
const usage = { inputTokens: 2000000, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 1000000, totalTokens: 3000000 };
const event = (id, fields = {}) => ({ version: 1, id, at: now.toISOString(), usage, status: 'complete', ...fields });
const identified = (model = 'deepseek-flash', provider = 'deepseek-account') => ({ provider, model, priceProfile: priceProfile(provider, model) });

test('CNY estimates price cached input once and use separate Flash/Pro output rates', () => {
  const flash = estimateCost(event('flash', identified()));
  assert.deepEqual(flash, { cny: 10.04, minCny: 10.04, maxCny: 10.04, tier: 'peak', assumed: false, timeAssumed: true });
  assert.deepEqual(estimateCost(event('pro', identified('deepseek-v4-pro'))), { cny: 36.3, minCny: 36.3, maxCny: 36.3, tier: 'peak', assumed: false, timeAssumed: true });
  assert.equal(priceProfile('deepseek', 'deepseek-v4-flash'), priceProfile('deepseek-account', 'deepseek-flash'));
  assert.equal(priceProfile('openrouter', 'deepseek-flash'), null);
  assert.equal(priceProfile('deepseek-custom', 'deepseek-flash'), null);
});

test('Old facts remain intact and visibly assumed; unavailable usage, unknown pricing and older rates are excluded', () => {
  const legacy = event('old');
  const before = JSON.stringify(legacy);
  assert.equal(estimateCost(legacy).assumed, true);
  assert.equal(JSON.stringify(legacy), before);
  for (const value of [event('missing', { usage: null }), event('other', identified('other')),
    event('third-party', identified('deepseek-flash', 'openrouter')),
    event('future-profile', { ...identified(), priceProfile: 'future-price' }),
    event('before-rates', { at: '2026-09-09T00:00:00Z' }),
    event('bad-cache', { usage: { ...usage, cacheReadTokens: 2000001 } })]) assert.equal(estimateCost(value), null);
});

test('Mixed models and legacy costs follow calendar periods, deduplication, and incomplete accounting', () => {
  const known = event('flash', identified());
  const result = summarizeUsage([known, known, event('legacy'), event('pro', { ...identified('deepseek-v4-pro'), status: 'failed' }),
    event('unknown', { usage: null, status: 'cancelled' }), event('unsupported', identified('other')),
    event('yesterday', { ...identified(), at: '2026-10-13T02:00:00Z' })], options);
  assert.equal(result.periods[0].requests, 5);
  const cost = result.periods[0].cost;
  assert.ok(Math.abs(cost.cny - 56.38) < 1e-12);
  assert.equal(cost.pricedRequests, 3); assert.equal(cost.assumedRequests, 1); assert.equal(cost.unpricedRequests, 2);
  assert.equal(result.periods[1].cost.cny, 10.04);
  assert.ok(Math.abs(result.periods[2].cost.cny - 66.42) < 1e-12);
  assert.equal(result.pricing.currency, 'CNY');
});

test('Model and price version survive reload without storing context or changing old record format', async () => {
  const root = new URL('../work/usage-tests/', import.meta.url);
  await mkdir(root, { recursive: true });
  const { fileURLToPath } = await import('node:url');
  const file = join(await mkdtemp(join(fileURLToPath(root), 'price-')), 'usage.jsonl');
  const store = createUsageStore(file, { clock: () => now, timeZone: 'UTC' });
  await store.record({ usage, status: 'complete', provider: 'deepseek-account', model: 'deepseek-flash' });
  await store.record({ usage, status: 'complete' });
  const records = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(records[0].priceProfile, priceProfile('deepseek-account', 'deepseek-flash'));
  assert.equal(records[1].provider, undefined);
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'id', 'model', 'priceProfile', 'provider', 'status', 'usage', 'version']);
  const result = await createUsageStore(file, { clock: () => now, timeZone: 'UTC' }).snapshot();
  assert.equal(result.periods[0].cost.cny, 20.08); assert.equal(result.periods[0].cost.assumedRequests, 1);
});

test('The recorded model is the model actually requested after configuration overrides', async () => {
  let record;
  const recommend = createRecommender({ async *stream(request) {
    assert.equal(request.provider, 'deepseek'); assert.equal(request.model, 'deepseek-v4-pro');
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } };
  } }, { provider: 'deepseek', model: 'deepseek-v4-pro' }, { async record(value) { record = value; } });
  await recommend({ sessionId: 'x', replyId: 'y', provider: 'other', model: 'other', user: 'PRIVATE', assistant: 'PRIVATE' });
  assert.equal(record.provider, 'deepseek'); assert.equal(record.model, 'deepseek-v4-pro');
  assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
});

test('Cost validation rejects impossible totals, bad currency and rates; tiny nonzero costs stay visible', () => {
  const result = summarizeUsage([event('flash', identified())], options);
  for (const cost of [{ ...result.periods[0].cost, minCny: NaN }, { ...result.periods[0].cost, maxCny: -1 },
    { ...result.periods[0].cost, unpricedRequests: 1 }, { ...result.periods[0].cost, assumedRequests: 2 }]) {
    assert.throws(() => validateUsageSnapshot({ ...result, periods: result.periods.map((p, i) => i ? p : { ...p, cost }) }));
  }
  assert.throws(() => validateUsageSnapshot({ ...result, pricing: { ...result.pricing, currency: 'USD' } }));
  assert.equal(formatCost(0), '¥0'); assert.equal(formatCost(0.001112), '¥0.001112');
  assert.equal(formatCost(0.00000002), '< ¥0.000001');
});
