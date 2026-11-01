import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialPrices, fetchOfficialPrices, createPriceStore, PRICE_INTERVAL_MS, PRICE_RETRY_MS } from '../src/price-updates.mjs';
import { BUILTIN_RATES, estimateCost, PRICE_SOURCE } from '../src/pricing.mjs';
import { createUsageStore } from '../src/usage.mjs';
import { createRecommender } from '../src/engine.mjs';
import { updatePricesDescriptor, validateUsageSnapshot, setPriceScheduleDescriptor, validatePriceSchedule } from '../src/common.mjs';

const html = `<table><tr><td colspan="3">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">价格</td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27元</td></tr></table>`;
const prices = () => parseOfficialPrices(html);
const changed = () => { const rates = prices(); rates.flash.offPeak.input = 3; rates.flash.peak.input = 7; return rates; };
const now = new Date('2026-10-14T03:00:00Z');
function memoryIO(initial = '') {
  let contents = initial;
  return { async mkdir() {}, async readFile() { return contents; }, async appendFile(_file, value) { contents += value; }, get contents() { return contents; } };
}
const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 110 };

test('Official table spans map CNY prices by model, category and tier, without assuming peak is double', () => {
  assert.deepEqual(prices().flash, { offPeak: { cache: 0.02, input: 1, output: 4 }, peak: { cache: 0.04, input: 2, output: 8 } });
  assert.equal(parseOfficialPrices(html.replace('<td>8元</td>', '<td>11元</td>')).flash.peak.output, 11);
  assert.deepEqual(parseOfficialPrices('<script>throw Error("untrusted")</script>' + html), prices());
  for (const invalid of [html + html, html.replace('4.5元', '$0.66'), html.replace('8元', '-8元'),
    html.replace('27元', '0元'), html.replace('百万tokens输出', '千tokens输出'), html.replace('deepseek-v4-pro', 'other'),
    html.replace('<td>8元</td>', ''), 'x'.repeat(2097153)]) assert.throws(() => parseOfficialPrices(invalid), /format/);
});

test('The only HTTP target is the official page, with no credentials or redirects and bounded HTML', async () => {
  let called = 0; const signal = new AbortController().signal;
  const fetcher = async (url, options) => {
    called++; assert.equal(url, PRICE_SOURCE + '/'); assert.equal(options.signal, signal);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'text/html' });
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  };
  assert.deepEqual(await fetchOfficialPrices({ signal, fetcher }), prices()); assert.equal(called, 1);
  for (const response of [new Response('', { status: 503 }), new Response(html, { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(2097153), { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(fetchOfficialPrices({ fetcher: async () => response }));
  }
});

test('Checks are weekly across restarts; reading usage/quotes never fetches; force refresh and concurrent calls share work', async () => {
  const io = memoryIO(); let at = new Date(now), calls = 0, finish;
  const fetchPrices = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const store = createPriceStore('prices', { io, clock: () => at, fetchPrices });
  assert.equal((await store.status()).lastCheckedAt, null);
  assert.equal((await store.quote('deepseek', 'deepseek-flash')).id, BUILTIN_RATES.flash.id);
  assert.equal(calls, 0);
  const a = store.refresh(), b = store.refresh({ force: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal((await store.status()).updating, true);
  finish(prices()); await Promise.all([a, b]);
  assert.equal((await store.quote('deepseek', 'deepseek-flash')).id, BUILTIN_RATES.flash.id);
  assert.equal((await store.status()).nextCheckAt, new Date(at.getTime() + PRICE_INTERVAL_MS).toISOString());
  await store.refresh(); assert.equal(calls, 1);
  const reloaded = createPriceStore('prices', { io, clock: () => at, fetchPrices: async () => { calls++; return prices(); } });
  await reloaded.refresh(); assert.equal(calls, 1);
  await reloaded.refresh({ force: true }); assert.equal(calls, 2);
  at = new Date(at.getTime() + PRICE_INTERVAL_MS); await reloaded.refresh(); assert.equal(calls, 3);
  assert.equal((await reloaded.status()).lastCheckedAt, at.toISOString());
  store.dispose(); reloaded.dispose();
});

test('Network and parsing failures retain prices, persist the retry delay, and a manual retry can recover', async () => {
  let at = new Date(now), fail = false, calls = 0;
  const io = memoryIO();
  const store = createPriceStore('prices', { io, clock: () => at, fetchPrices: async () => {
    calls++; if (fail) throw Error('format'); return changed();
  } });
  await store.refresh(); const original = await store.quote('deepseek', 'deepseek-flash');
  at = new Date(at.getTime() + 1000); fail = true;
  const status = await store.refresh({ force: true });
  assert.match(status.error, /格式变化/); assert.equal(status.lastCheckedAt, now.toISOString());
  assert.equal(status.nextCheckAt, new Date(at.getTime() + PRICE_RETRY_MS).toISOString());
  assert.deepEqual(await store.quote('deepseek', 'deepseek-flash'), original);
  await store.refresh(); assert.equal(calls, 2);
  const reloaded = createPriceStore('prices', { io, clock: () => at, fetchPrices: async () => { calls++; return prices(); } });
  await reloaded.refresh(); assert.equal(calls, 2); assert.match((await reloaded.status()).error, /格式变化/);
  await reloaded.refresh({ force: true }); assert.equal(calls, 3); assert.equal((await reloaded.status()).error, null);
  store.dispose(); reloaded.dispose();
});

test('Updated rates are frozen in usage records and survive reload without repricing old or in-flight requests', async () => {
  let at = new Date(now), nextRates = prices(); const priceIO = memoryIO(), usageIO = memoryIO();
  const priceStore = createPriceStore('prices', { io: priceIO, clock: () => at, fetchPrices: async () => nextRates });
  const usageStore = createUsageStore('usage', { io: usageIO, clock: () => at, timeZone: 'UTC', prices: priceStore });
  let resume;
  const recommender = createRecommender({ async *stream() {
    await new Promise(resolve => { resume = resolve; }); yield { type: 'usage', usage };
  } }, {}, usageStore);
  const input = { sessionId: 'a', replyId: 'b', provider: 'deepseek', model: 'deepseek-flash', user: 'PRIVATE', assistant: 'PRIVATE' };
  const oldRequest = recommender(input); await new Promise(resolve => setImmediate(resolve));
  at = new Date(at.getTime() + 1000); nextRates = changed(); await priceStore.refresh({ force: true });
  resume(); await oldRequest;
  const quote = await usageStore.quote('deepseek', 'deepseek-flash');
  assert.match(quote.id, /^remote-/); assert.equal(quote.offPeak.input, 3);
  await usageStore.record({ usage, status: 'complete', provider: input.provider, model: input.model, priceSnapshot: quote });
  const records = usageIO.contents.split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(records[0].priceSnapshot.offPeak.input, 1); assert.equal(records[1].priceSnapshot.offPeak.input, 3);
  assert.equal(usageIO.contents.includes('PRIVATE'), false);
  assert.equal(estimateCost(records[0]).cny, 0.00028); assert.equal(estimateCost(records[1]).cny, 0.00078);
  const result = await createUsageStore('usage', { io: usageIO, clock: () => at, timeZone: 'UTC' }).snapshot();
  assert.ok(Math.abs(result.periods[0].cost.cny - 0.00106) < 1e-12);
  assert.equal(result.periods[0].cost.assumedRequests, 0);
  const restored = createPriceStore('prices', { io: priceIO, clock: () => at });
  assert.deepEqual(await restored.quote('deepseek', 'deepseek-flash'), quote);
  priceStore.dispose(); restored.dispose();
});

test('Persistence failure is visible, malformed saved prices cannot poison a quote, and unload aborts retrieval', async () => {
  const badIO = { ...memoryIO('{interrupted\n'), async appendFile() { throw Error('write'); } };
  const store = createPriceStore('prices', { io: badIO, clock: () => now, fetchPrices: async () => prices(), autoUpdate: false });
  const status = await store.refresh({ force: true }); assert.equal(status.persistent, false); assert.match(status.error, /保存/);
  assert.equal(status.nextCheckAt, null); assert.equal(status.autoUpdate, false); store.dispose();
  let signal;
  const active = createPriceStore('prices', { io: memoryIO(), clock: () => now, fetchPrices: async input => {
    signal = input.signal; await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('network'))));
  } });
  const pending = active.refresh(); await new Promise(resolve => setImmediate(resolve));
  active.dispose(); await pending; assert.equal(signal.aborted, true); assert.equal((await active.status()).lastCheckedAt, null);
});

test('The manual RPC has no URL argument and validates status metadata', async () => {
  const store = createPriceStore('prices', { io: memoryIO(), clock: () => now, autoUpdate: false });
  const usageStore = createUsageStore('usage', { io: memoryIO(), clock: () => now, prices: store });
  const value = await usageStore.snapshot(), descriptor = updatePricesDescriptor();
  assert.equal(descriptor.method, 'updatePrices'); assert.deepEqual(descriptor.parameters, []);
  assert.equal(descriptor.result.create().parse(value), value);
  assert.throws(() => validateUsageSnapshot({ ...value, pricing: { ...value.pricing, nextCheckAt: 'bad' } }));
  assert.throws(() => validateUsageSnapshot({ ...value, pricing: { ...value.pricing, intervalDays: 0 } }));
  store.dispose();
});

test('Saved periods recalculate the deadline and override constructor defaults after restart', async () => {
  const io = memoryIO(); let at = new Date(now), calls = 0;
  const store = createPriceStore('prices', { io, clock: () => at, fetchPrices: async () => { calls++; return prices(); } });
  await store.refresh(); assert.equal(calls, 1);
  for (const intervalDays of [1, 3, 7, 30]) {
    await store.setSchedule({ autoUpdate: true, intervalDays });
    assert.equal((await store.status()).nextCheckAt, new Date(now.getTime() + intervalDays * 86400000).toISOString());
  }
  await store.setSchedule({ autoUpdate: false, intervalDays: 30 });
  at = new Date(now.getTime() + 31 * 86400000);
  await store.refresh(); assert.equal(calls, 1); assert.equal((await store.status()).nextCheckAt, null);
  const restored = createPriceStore('prices', { io, clock: () => at, autoUpdate: true, intervalMs: 86400000,
    fetchPrices: async () => { calls++; return prices(); } });
  assert.equal((await restored.status()).autoUpdate, false); assert.equal((await restored.status()).intervalDays, 30);
  await restored.refresh(); assert.equal(calls, 1);
  await restored.refresh({ force: true }); assert.equal(calls, 2);
  await restored.setSchedule({ autoUpdate: true, intervalDays: 1 });
  at = new Date(at.getTime() + 86400000); await restored.refresh(); assert.equal(calls, 3);
  store.dispose(); restored.dispose();
});

test('Failed settings writes cannot change this session or leak into a later price append', async () => {
  const io = memoryIO(); let denied = true;
  const store = createPriceStore('prices', { clock: () => now,
    io: { ...io, async appendFile(file, value) { if (denied) throw Error('denied'); await io.appendFile(file, value); } },
    fetchPrices: async () => prices() });
  await assert.rejects(store.setSchedule({ autoUpdate: false, intervalDays: 1 }), /could not be saved/);
  assert.equal((await store.status()).autoUpdate, true); assert.equal((await store.status()).intervalDays, 7);
  denied = false; await store.refresh({ force: true });
  assert.equal(io.contents.includes('settings'), false);
  const restored = createPriceStore('prices', { io, clock: () => now });
  assert.equal((await restored.status()).autoUpdate, true); assert.equal((await restored.status()).intervalDays, 7);
  store.dispose(); restored.dispose();
});

test('Concurrent preferences and rate writes preserve both records and the chosen schedule', async () => {
  const io = memoryIO(); let finish;
  const store = createPriceStore('prices', { io, clock: () => now, fetchPrices: async () => new Promise(resolve => { finish = resolve; }) });
  const price = store.refresh(); await new Promise(resolve => setImmediate(resolve));
  const settings = store.setSchedule({ autoUpdate: false, intervalDays: 3 });
  finish(prices()); await Promise.all([price, settings]);
  assert.equal((await store.status()).autoUpdate, false); assert.equal((await store.status()).intervalDays, 3);
  const rows = io.contents.split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows.filter(row => row.status === 'settings').length, 1); assert.equal(rows.filter(row => row.status === 'ok').length, 1);
  const restored = createPriceStore('prices', { io, clock: () => now });
  assert.equal((await restored.status()).autoUpdate, false); assert.equal((await restored.status()).intervalDays, 3);
  assert.equal((await restored.quote('deepseek', 'deepseek-flash')).offPeak.input, 1);
  store.dispose(); restored.dispose();
});

test('The schedule RPC strictly rejects invalid fields, periods, and value types', () => {
  const descriptor = setPriceScheduleDescriptor();
  assert.equal(descriptor.method, 'setPriceSchedule'); assert.equal(descriptor.parameters[0].wire, 'schedule');
  assert.deepEqual(descriptor.parameters[0].codec.create().parse({ autoUpdate: false, intervalDays: 7 }), { autoUpdate: false, intervalDays: 7 });
  for (const value of [null, {}, [], { autoUpdate: 'false', intervalDays: 7 }, { autoUpdate: true, intervalDays: 0 },
    { autoUpdate: true, intervalDays: 31 }, { autoUpdate: true, intervalDays: 1.5 }, { autoUpdate: false, intervalDays: 7, url: 'https://other.test' }]) {
    assert.throws(() => validatePriceSchedule(value));
  }
});

test('Appending valid prices does not conceal corrupt history or misreport a successful write as a storage failure', async () => {
  const io = memoryIO('{corrupt\n');
  const store = createPriceStore('prices', { io, clock: () => now, fetchPrices: async () => prices() });
  assert.equal((await store.status()).persistent, false);
  const result = await store.refresh({ force: true });
  assert.equal(result.persistent, false); assert.equal(result.error, null);
  assert.ok(result.lastCheckedAt); assert.ok(io.contents.startsWith('{corrupt\n'));
  const restored = createPriceStore('prices', { io, clock: () => now });
  assert.equal((await restored.status()).persistent, false);
  assert.equal((await restored.quote('deepseek', 'deepseek-flash')).offPeak.input, 1);
  store.dispose(); restored.dispose();
});
