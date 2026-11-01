import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactUsageLog, createUsageStore, summarizeUsage } from '../src/usage.mjs';
import { USAGE_COUNTERS, validateUsageSnapshot } from '../src/common.mjs';

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 };
const event = (id, at, extra = {}) => ({ version: 1, id, at, status: 'complete', usage, ...extra });
const now = new Date('2026-11-01T04:00:00Z');
const options = { now, timeZone: 'Asia/Shanghai' };
const old = event('old', '2026-10-02T15:59:59Z');
const boundary = event('boundary', '2026-10-02T16:00:00Z');
const today = event('today', '2026-11-01T00:00:00Z');
const jsonl = events => events.map(value => JSON.stringify(value)).join('\n') + '\n';
const locks = new Map();
// Unit-test adapter. SDK integration separately exercises the real DSH helpers.
const atomic = {
  withFileLock(file, operation) {
    const task = (locks.get(file) ?? Promise.resolve()).then(operation);
    locks.set(file, task.catch(() => {})); return task;
  },
  async writeFileAtomic(file, contents, options) {
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, contents, { ...options, flag: 'wx' }); await rename(temp, file);
  },
};
async function fixture(contents) {
  const root = fileURLToPath(new URL('../work/retention-tests/', import.meta.url));
  await mkdir(root, { recursive: true });
  const file = join(await mkdtemp(join(root, 'run-')), 'usage.jsonl');
  await writeFile(file, contents); return file;
}

test('Retention keeps exactly 30 local calendar days, including today, and removes expired request details', () => {
  const result = compactUsageLog(jsonl([old, boundary, today]), [], options);
  assert.equal(result.cutoff, '2026-10-03');
  assert.deepEqual(result.events.map(value => value.id), ['boundary', 'today']);
  assert.equal(result.archive.totals.requests, 1); assert.equal(result.archive.trackingSince, old.at);
  assert.equal(result.text.includes('"id":"old"'), false);
  const before = summarizeUsage([old, boundary, today], options);
  const after = summarizeUsage(result.events, { ...options, archive: result.archive });
  for (const key of USAGE_COUNTERS) assert.equal(after.lifetime[key], before.lifetime[key]);
  assert.ok(Math.abs(after.lifetime.cost.cny - before.lifetime.cost.cny) < 1e-12);
  assert.equal(after.trackingSince, before.trackingSince);
  assert.deepEqual(after.periods.map(value => value.requests), before.periods.map(value => value.requests));
});

test('Repeated cleanup and a later month preserve cumulative totals without storing old facts', () => {
  const first = compactUsageLog(jsonl([old, boundary, today]), [], options);
  const repeat = compactUsageLog(first.text, [], options);
  assert.equal(repeat.changed, false); assert.deepEqual(repeat.archive, first.archive);
  const later = compactUsageLog(repeat.text, [], { ...options, now: new Date('2026-12-02T04:00:00Z') });
  assert.equal(later.events.length, 0); assert.equal(later.archive.totals.requests, 3);
  assert.equal(later.archive.totals.totalTokens, 360);
  assert.equal(JSON.parse(later.text).kind, 'usage-summary');
});

test('Cleanup deduplicates legacy rows before folding their usage into the aggregate', () => {
  const result = compactUsageLog(jsonl([old, old, boundary, boundary]), [], options);
  assert.equal(result.archive.totals.requests, 1); assert.equal(result.events.length, 1);
  assert.equal(summarizeUsage(result.events, { ...options, archive: result.archive }).lifetime.totalTokens, 240);
});

test('Archived unknown usage, failures, cancellations and price assumptions retain their counters', () => {
  const facts = [old, { ...old, id: 'failed', status: 'failed', usage: null }, { ...old, id: 'cancelled', status: 'cancelled' }];
  const result = compactUsageLog(jsonl(facts), [], options);
  const before = summarizeUsage(facts, options), after = summarizeUsage([], { ...options, archive: result.archive });
  assert.deepEqual(after.lifetime, before.lifetime);
});

test('Retention uses calendar-day boundaries even across DST and non-Beijing Host timezones', () => {
  const result = compactUsageLog(jsonl([event('old', '2026-10-03T03:59:59Z'), event('keep', '2026-10-03T04:00:00Z')]),
    [], { now: new Date('2026-11-01T17:00:00Z'), timeZone: 'America/New_York' });
  assert.equal(result.cutoff, '2026-10-03'); assert.deepEqual(result.events.map(value => value.id), ['keep']);
});

test('New request start time determines retention while future facts stay intact but are not counted', () => {
  const started = event('started-old', today.at, { startedAt: old.at, billingTier: 'offPeak', billingRule: 'deepseek-cn-v1' });
  const future = event('future', '2026-12-01T00:00:00Z');
  const result = compactUsageLog(jsonl([started, future]), [], options);
  assert.equal(result.archive.totals.requests, 1); assert.equal(result.events[0].id, 'future');
  assert.equal(summarizeUsage(result.events, { ...options, archive: result.archive }).lifetime.requests, 1);
});

test('Production-style store cleans on read, persists the aggregate, and restores it on restart', async () => {
  const file = await fixture(jsonl([old, boundary, today])); let writes = 0;
  const retention = { ...atomic, async writeFileAtomic(...args) { writes++; return atomic.writeFileAtomic(...args); } };
  const store = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention });
  const result = await store.snapshot();
  assert.equal(result.lifetime.requests, 3); assert.equal(result.retention.days, 30);
  assert.equal(result.retention.archivedRequests, 1); assert.equal(result.retention.cleanupPending, false);
  assert.equal(result.retention.retainedFrom, '2026-10-03'); assert.equal(writes, 1);
  await store.snapshot(); assert.equal(writes, 1);
  const restored = await createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention }).snapshot();
  assert.equal(restored.lifetime.totalTokens, 360); assert.equal(restored.trackingSince, old.at);
});

test('Two stores share the writer lock, archive once, and never lose concurrent new requests', async () => {
  const file = await fixture(jsonl([old]));
  const a = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention: atomic });
  const b = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention: atomic });
  await Promise.all([a.maintain(), b.maintain(), a.record({ usage, status: 'complete' }), b.record({ usage, status: 'complete' })]);
  const result = await a.snapshot();
  assert.equal(result.lifetime.requests, 3); assert.equal(result.retention.archivedRequests, 1);
  assert.equal(result.lifetime.totalTokens, 360);
});

test('Atomic replacement failure preserves the complete old file and successful retry cleans it', async () => {
  const original = jsonl([old, today]), file = await fixture(original); let fail = true;
  const retention = { ...atomic, async writeFileAtomic(...args) { if (fail) throw Error('denied'); return atomic.writeFileAtomic(...args); } };
  const store = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention });
  let result = await store.snapshot();
  assert.equal(await readFile(file, 'utf8'), original); assert.equal(result.lifetime.requests, 2);
  assert.equal(result.retention.cleanupPending, true);
  fail = false; result = await store.snapshot();
  assert.equal(result.retention.archivedRequests, 1); assert.equal(result.retention.cleanupPending, false);
});

test('Corrupt logs defer cleanup, preserve the original bytes, and still append new usage safely', async () => {
  const original = jsonl([old]) + '{interrupted', file = await fixture(original);
  const store = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention: atomic });
  await store.record({ usage, status: 'complete' });
  const contents = await readFile(file, 'utf8'), result = await store.snapshot();
  assert.ok(contents.startsWith(original)); assert.equal(result.lifetime.requests, 2);
  assert.equal(result.retention.cleanupPending, true); assert.equal(result.persistent, true);
  assert.equal(result.unreadableRecords, 1);
});

test('Invalid cumulative headers are never silently discarded by cleanup', () => {
  const first = compactUsageLog(jsonl([old]), [], options);
  const broken = JSON.parse(first.text); broken.totals.totalTokens = -1;
  assert.throws(() => compactUsageLog(jsonl([broken, today]), [], options), /repair/);
});

test('A committed old request is not archived twice if lock release reports an error', async () => {
  const file = await fixture(''); let releaseError = true;
  const retention = { ...atomic, async withFileLock(file, operation) {
    return atomic.withFileLock(file, async () => { const value = await operation();
      if (releaseError) { releaseError = false; throw Error('release failed'); } return value; });
  } };
  const store = createUsageStore(file, { clock: () => now, timeZone: options.timeZone, retention });
  await store.record({ usage, status: 'complete', startedAt: old.at });
  const result = await store.snapshot();
  assert.equal(result.lifetime.requests, 1); assert.equal(result.retention.archivedRequests, 1);
});

test('RPC metadata rejects impossible retained-day and archived-count claims', () => {
  const result = summarizeUsage([today], options);
  for (const retention of [{ days: 0, retainedFrom: '2026-10-03', archivedRequests: 0, cleanupPending: false },
    { days: 30, retainedFrom: 'invalid', archivedRequests: 0, cleanupPending: false },
    { days: 30, retainedFrom: '2026-10-03', archivedRequests: 2, cleanupPending: false }]) {
    assert.throws(() => validateUsageSnapshot({ ...result, retention }));
  }
});
