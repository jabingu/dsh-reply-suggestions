import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { normalizeUsage, usageDescriptor, validateUsageSnapshot } from '../src/common.mjs';
import { createUsageStore, summarizeUsage } from '../src/usage.mjs';
import { createRecommender } from '../src/engine.mjs';

const raw = { inputTokens: 80, outputTokens: 20, cacheReadTokens: 20, totalTokens: 120 };
const usage = normalizeUsage(raw);
const now = new Date('2026-10-14T00:30:00Z');
const options = { now, timeZone: 'Asia/Shanghai' };
const event = (id, at, value = usage, status = 'complete') => ({ version: 1, id, at, usage: value, status });
const input = { sessionId: 'a', replyId: '1', provider: 'deepseek-account', model: 'deepseek-flash',
  user: 'PRIVATE_USER_CONTEXT', assistant: 'PRIVATE_ASSISTANT_CONTEXT' };
const recorded = (usage, status) => ({ usage, status, provider: input.provider, model: input.model, startedAt: now.toISOString() });
async function fixture() {
  const root = fileURLToPath(new URL('../work/usage-tests/', import.meta.url));
  await mkdir(root, { recursive: true });
  return join(await mkdtemp(join(root, 'run-')), 'usage.jsonl');
}

test('Usage totals include cache without counting it twice when the provider gives a total', () => {
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 120 });
  assert.equal(normalizeUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, totalTokens: 120 }).totalTokens, 120);
  assert.equal(normalizeUsage({ inputTokens: 80, outputTokens: 20, cacheReadTokens: 20 }).totalTokens, 120);
  for (const value of [undefined, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 },
    { inputTokens: '80', outputTokens: 20 }, { ...raw, totalTokens: 10 }, { ...raw, cacheReadTokens: NaN }]) assert.equal(normalizeUsage(value), null);
});

test('Calendar windows use local midnight, include today in 7/30 days, and deduplicate record ids', () => {
  const events = [event('today', '2026-10-13T16:00:00Z'), event('yesterday', '2026-10-13T15:59:59Z'),
    event('unknown', '2026-10-13T10:00:00Z', null, 'failed'), event('week-start', '2026-10-07T16:00:00Z'),
    event('before-week', '2026-10-07T15:59:59Z'), event('month-start', '2026-09-14T16:00:00Z'),
    event('before-month', '2026-09-14T15:59:59Z'), event('old', '2026-01-01T00:00:00Z'),
    event('future', '2026-10-14T01:00:00Z')];
  events.push(events[0]);
  const result = summarizeUsage(events, options);
  assert.deepEqual(result.periods.map(period => period.totalTokens), [120, 120, 360, 600]);
  assert.deepEqual(result.periods.map(period => period.requests), [1, 2, 4, 6]);
  assert.equal(result.periods[1].unknownRequests, 1); assert.equal(result.periods[1].failedRequests, 1);
  assert.equal(result.trackingSince, '2026-01-01T00:00:00Z');
  assert.equal(result.periods[0].inputTokens + result.periods[0].outputTokens, result.periods[0].totalTokens);
});

test('Lifetime totals count old records once, include unknown costs honestly and exclude future/corrupt records', () => {
  const old = event('old', '2026-09-10T06:00:00Z', usage, 'cancelled');
  const value = summarizeUsage([old, old, event('today', '2026-10-14T00:00:00Z'),
    event('missing', '2026-09-01T00:00:00Z', null, 'failed'), event('future', '2026-10-15T00:00:00Z'),
    { ...old, id: 'invalid', version: 999 }], options);
  assert.equal(value.periods[3].totalTokens, 120);
  assert.equal(value.lifetime.id, 'all'); assert.equal(value.lifetime.totalTokens, 240);
  assert.equal(value.lifetime.inputTokens, 200); assert.equal(value.lifetime.outputTokens, 40);
  assert.equal(value.lifetime.requests, 3); assert.equal(value.lifetime.unknownRequests, 1);
  assert.equal(value.lifetime.failedRequests, 1); assert.equal(value.lifetime.cancelledRequests, 1);
  assert.equal(value.lifetime.cost.pricedRequests, 2); assert.equal(value.lifetime.cost.unpricedRequests, 1);
  assert.ok(Math.abs(value.lifetime.cost.cny - 0.0004812) < 1e-12);
  assert.equal(value.unreadableRecords, 1);
  const futureOnly = summarizeUsage([event('future', '2026-10-15T00:00:00Z')], options);
  assert.equal(futureOnly.lifetime.requests, 0); assert.equal(futureOnly.trackingSince, null);
  const { lifetime, ...legacy } = value;
  assert.equal(validateUsageSnapshot(legacy), legacy); // Older four-period replies still render.
  assert.throws(() => validateUsageSnapshot({ ...value, lifetime: { ...lifetime, id: 'bad' } }));
  assert.throws(() => validateUsageSnapshot({ ...value, lifetime: { ...lifetime, totalTokens: 0 } }));
});

test('DST, year rollover and leap-day boundaries are calendar dates rather than 24-hour windows', () => {
  const dst = summarizeUsage([event('a', '2026-11-01T04:00:00Z'), event('b', '2026-11-01T03:59:59Z')],
    { now: new Date('2026-11-01T17:00:00Z'), timeZone: 'America/New_York' });
  assert.deepEqual(dst.periods.slice(0, 2).map(period => period.requests), [1, 1]);
  const year = summarizeUsage([event('a', '2025-12-31T12:00:00Z')], { now: new Date('2026-01-01T12:00:00Z'), timeZone: 'UTC' });
  assert.equal(year.periods[1].requests, 1); assert.equal(year.periods[2].requests, 1);
  const leap = summarizeUsage([event('a', '2028-02-29T12:00:00Z'), event('b', '2028-02-01T00:00:00Z'), event('c', '2028-01-31T23:59:59Z')],
    { now: new Date('2028-03-01T12:00:00Z'), timeZone: 'UTC' });
  assert.equal(leap.periods[1].requests, 1); assert.equal(leap.periods[3].requests, 2);
});

test('The usage RPC has no user arguments and rejects malformed summaries', () => {
  const descriptor = usageDescriptor();
  assert.equal(descriptor.method, 'usage'); assert.deepEqual(descriptor.parameters, []);
  const empty = summarizeUsage([], options);
  assert.equal(empty.trackingSince, null); assert.equal(descriptor.result.create().parse(empty), empty);
  assert.throws(() => validateUsageSnapshot({ ...empty, periods: [] }));
  assert.throws(() => validateUsageSnapshot({ ...empty, persistent: undefined }));
  assert.throws(() => validateUsageSnapshot({ ...empty, periods: empty.periods.map((p, i) => i ? p : { ...p, totalTokens: 1 }) }));
});

test('File records survive reload, parallel writers and duplicate lines without saving conversation text', async () => {
  const file = await fixture(); const config = { clock: () => now, timeZone: 'Asia/Shanghai' };
  const first = createUsageStore(file, config), second = createUsageStore(file, config);
  await Promise.all([first.record({ usage, status: 'complete' }), second.record({ usage: null, status: 'failed' })]);
  const text = await readFile(file, 'utf8');
  await appendFile(file, text.split('\n').find(line => line.trim()) + '\n');
  const result = await createUsageStore(file, config).snapshot();
  assert.equal(result.periods[0].requests, 2); assert.equal(result.periods[0].unknownRequests, 1);
  assert.equal(result.periods[0].totalTokens, 120); assert.equal(result.persistent, true);
  assert.equal(/PRIVATE_|sessionId|replyId|provider|model/.test(text), false);
});

test('Interrupted or corrupt JSONL is preserved, marked incomplete, and does not swallow the next record', async () => {
  const file = await fixture(); await writeFile(file, '{interrupted');
  const store = createUsageStore(file, { clock: () => now, timeZone: 'UTC' });
  await store.record({ usage, status: 'complete' });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.unreadableRecords, 1); assert.equal(snapshot.periods[0].requests, 1);
  assert.ok((await readFile(file, 'utf8')).startsWith('{interrupted\n'));
});

test('Write failures retain volatile records and later flush them once, with a visible persistence state', async () => {
  let contents = ''; let denied = true; let warnings = 0;
  const store = createUsageStore('virtual/usage.jsonl', { clock: () => now, timeZone: 'UTC', warn: () => warnings++,
    io: { async mkdir() {}, async readFile() { return contents; }, async appendFile(_path, text) {
      if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); contents += text;
    } } });
  await store.record({ usage, status: 'complete' }); await store.record({ usage, status: 'cancelled' });
  const failed = await store.snapshot(); assert.equal(failed.persistent, false);
  assert.equal(failed.periods[0].requests, 2); assert.equal(failed.periods[0].cancelledRequests, 1); assert.equal(warnings, 1);
  denied = false; await store.record({ usage: null, status: 'failed' });
  const restored = await store.snapshot(); assert.equal(restored.persistent, true);
  assert.equal(restored.periods[0].requests, 3); assert.equal(restored.periods[0].totalTokens, 240);
});

test('Recommendations count one final usage per actual request; cache and skipped calls count nothing', async () => {
  const records = []; let calls = 0;
  const recommend = createRecommender({ async *stream() {
    calls++; yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } };
    yield { type: 'text-delta', index: 0, text: '请举例。' };
    yield { type: 'usage', usage: raw }; yield { type: 'usage', usage: raw };
  } }, {}, { requestTime: () => now.toISOString(), async record(value) { records.push(value); } });
  await recommend(input); await recommend(input);
  assert.equal(calls, 1); assert.equal(records.length, 1); assert.deepEqual(records[0], recorded(usage, 'complete'));
  await assert.rejects(recommend({ ...input, model: '' })); assert.equal(records.length, 1);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(recommend(input, cancelled.signal));
  assert.equal(records.length, 1);
  const disabled = createRecommender({ stream() { throw Error('unexpected'); } }, { enabled: false }, { record() { throw Error('unexpected'); } });
  assert.equal(await disabled(input), '');
});

test('Missing usage, rejected output and failed/cancelled streams retain honest accounting', async () => {
  const records = []; const recorder = { requestTime: () => now.toISOString(), async record(value) { records.push(value); } };
  await createRecommender({ async *stream() { yield { type: 'text-delta', index: 0, text: '请继续。' }; } }, {}, recorder)(input);
  assert.deepEqual(records.pop(), recorded(null, 'complete'));
  await assert.rejects(createRecommender({ async *stream() { yield { type: 'usage', usage: raw }; throw Error('network'); } }, {}, recorder)(input), /network/);
  assert.deepEqual(records.pop(), recorded(usage, 'failed'));
  const controller = new AbortController();
  await assert.rejects(createRecommender({ async *stream() {
    yield { type: 'usage', usage: raw }; controller.abort(new Error('cancelled')); yield { type: 'finish' };
  } }, {}, recorder)(input, controller.signal), /cancelled/);
  // Callers cancel immediately; the shared model job records its final usage independently.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(records.pop(), recorded(usage, 'cancelled'));
  assert.equal(await createRecommender({ async *stream() {
    yield { type: 'text-delta', index: 0, text: 'x'.repeat(1100) }; yield { type: 'usage', usage: raw };
  } }, {}, recorder)(input), '');
  assert.deepEqual(records.pop(), recorded(usage, 'complete'));
});

test('Concurrent identical requests share one model call, price quote and usage record', async () => {
  let calls = 0, quotes = 0, finish; const records = [];
  const recommend = createRecommender({ async *stream() {
    calls++; await new Promise(resolve => { finish = resolve; });
    yield { type: 'text-delta', index: 0, text: '请给一个例子。' }; yield { type: 'usage', usage: raw };
  } }, {}, { async quote() { quotes++; return null; }, async record(value) { records.push(value); } });
  const a = recommend(input), b = recommend(input);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(quotes, 1);
  finish(); assert.deepEqual(await Promise.all([a, b]), ['请给一个例子。', '请给一个例子。']);
  assert.equal(records.length, 1); assert.equal(records[0].usage.totalTokens, 120);
  assert.equal(await recommend(input), '请给一个例子。'); assert.equal(calls, 1);
});

test('Cancelling one subscriber does not cancel the recommendation another subscriber still needs', async () => {
  let calls = 0, modelSignal, finish; const records = [];
  const recommend = createRecommender({ async *stream(options) {
    calls++; modelSignal = options.signal; await new Promise(resolve => { finish = resolve; });
    yield { type: 'text-delta', index: 0, text: '请继续。' }; yield { type: 'usage', usage: raw };
  } }, {}, { async record(value) { records.push(value); } });
  const controller = new AbortController(), a = recommend(input, controller.signal), b = recommend(input);
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = assert.rejects(a, /caller cancelled/); controller.abort(Error('caller cancelled')); await cancelled;
  assert.equal(modelSignal.aborted, false); finish(); assert.equal(await b, '请继续。');
  assert.equal(calls, 1); assert.equal(records.length, 1); assert.equal(records[0].status, 'complete');
});

test('The last cancelled subscriber stops the shared model and preserves its reported usage once', async () => {
  let calls = 0, modelSignal; const records = [];
  const recommend = createRecommender({ async *stream(options) {
    calls++; modelSignal = options.signal; yield { type: 'usage', usage: raw };
    if (calls === 1) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    else yield { type: 'text-delta', index: 0, text: '重新生成。' };
  } }, {}, { async record(value) { records.push(value); } });
  const one = new AbortController(), two = new AbortController();
  const a = recommend(input, one.signal), b = recommend(input, two.signal);
  await new Promise(resolve => setImmediate(resolve));
  const rejected = [assert.rejects(a, /cancelled/), assert.rejects(b, /cancelled/)];
  one.abort(Error('cancelled')); assert.equal(modelSignal.aborted, false); two.abort(Error('cancelled'));
  await Promise.all(rejected); await new Promise(resolve => setImmediate(resolve));
  assert.equal(modelSignal.aborted, true); assert.equal(records.length, 1);
  assert.equal(records[0].status, 'cancelled'); assert.equal(records[0].usage.totalTokens, 120);
  assert.equal(await recommend(input), '重新生成。'); assert.equal(calls, 2);
});

test('Two distinct jobs are the limit, but duplicates still join without occupying another slot', async () => {
  let calls = 0; const releases = [], records = [];
  const recommend = createRecommender({ async *stream() {
    calls++; await new Promise(resolve => releases.push(resolve)); yield { type: 'text-delta', index: 0, text: '请继续。' };
  } }, {}, { async record(value) { records.push(value); } });
  const a = recommend(input), b = recommend({ ...input, replyId: 'two' }), duplicate = recommend(input);
  assert.equal(await recommend({ ...input, replyId: 'three' }), '');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  releases.forEach(resolve => resolve()); await Promise.all([a, b, duplicate]); assert.equal(records.length, 2);
});
