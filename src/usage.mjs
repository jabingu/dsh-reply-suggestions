import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { USAGE_COUNTERS, USAGE_PERIODS, validateUsageSnapshot } from './common.mjs';
import { estimateCost, priceProfile, PRICE_SOURCE, PRICE_CHECKED_AT, validPriceSnapshot } from './pricing.mjs';
import { billingTier, BILLING_RULE, HOLIDAY_YEARS } from './billing-calendar.mjs';

const statuses = new Set(['complete', 'failed', 'cancelled']);
export const RETENTION_DAYS = 30;
const dateFormatter = timeZone => new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
function dateKey(formatter, date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function retentionStart(now, timeZone, days = RETENTION_DAYS) {
  const today = dateKey(dateFormatter(timeZone), now);
  return new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
}
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
  persistent = true, unreadableRecords = 0, pricing = { currency: 'CNY', checkedAt: PRICE_CHECKED_AT, source: PRICE_SOURCE },
  archive, retention } = {}) {
  const formatter = dateFormatter(timeZone);
  const today = dateKey(formatter, now);
  const dayOffset = days => new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  const yesterday = dayOffset(1), weekStart = dayOffset(6), monthStart = dayOffset(29);
  const emptyPeriod = id => ({ id, ...Object.fromEntries(USAGE_COUNTERS.map(key => [key, 0])),
    cost: { cny: 0, minCny: 0, maxCny: 0, pricedRequests: 0, assumedRequests: 0, unpricedRequests: 0, legacyTimeRequests: 0 } });
  const periods = USAGE_PERIODS.map(emptyPeriod);
  const lifetime = archive ? structuredClone(archive.totals) : emptyPeriod('all');
  const seen = new Set();
  let trackingSince = archive?.trackingSince ?? null;
  for (const event of events) {
    if (!validEvent(event)) { unreadableRecords++; continue; }
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const at = event.startedAt ?? event.at;
    if (Date.parse(at) > now.getTime()) continue;
    if (!trackingSince || Date.parse(at) < Date.parse(trackingSince)) trackingSince = at;
    const key = dateKey(formatter, new Date(at));
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
    pricing: { ...pricing, holidayYears: [...HOLIDAY_YEARS] }, ...(retention ? { retention } : {}) });
}

function readUsageDocument(contents) {
  const events = []; let archive; let unreadableRecords = 0;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.kind !== 'usage-summary') { events.push(item); continue; }
      if (archive || item.version !== 1 || typeof item.trackingSince !== 'string' || !Number.isFinite(Date.parse(item.trackingSince))) throw Error('Invalid summary');
      const check = summarizeUsage([]);
      validateUsageSnapshot({ ...check, lifetime: item.totals });
      if (item.totals.cost?.cny === undefined || item.totals.requests < 1) throw Error('Invalid summary totals');
      archive = item;
    } catch { unreadableRecords++; }
  }
  return { events, archive, unreadableRecords };
}

// One atomic document commit carries both the old-detail aggregate and remaining facts.
export function compactUsageLog(contents, additions = [], { now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, days = RETENTION_DAYS } = {}) {
  const document = readUsageDocument(contents);
  if (document.unreadableRecords || document.events.some(event => !validEvent(event))) throw Error('Usage log needs repair before retention cleanup');
  const cutoff = retentionStart(now, timeZone, days), formatter = dateFormatter(timeZone);
  const recent = [], expired = [], seen = new Set();
  for (const event of [...document.events, ...additions]) {
    if (!validEvent(event)) throw Error('Invalid usage addition');
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    (dateKey(formatter, new Date(event.startedAt ?? event.at)) < cutoff ? expired : recent).push(event);
  }
  let archive = document.archive;
  if (expired.length) {
    const summary = summarizeUsage(expired, { now, timeZone, archive });
    archive = { kind: 'usage-summary', version: 1, trackingSince: summary.trackingSince, totals: summary.lifetime };
  }
  const text = [archive, ...recent].filter(Boolean).map(value => JSON.stringify(value)).join('\n');
  return { text: text ? text + '\n' : '', events: recent, archive, cutoff,
    changed: expired.length > 0 || additions.length > 0 };
}

// Production retention uses DSH's cross-process lock and atomic replace helpers.
// Without retention helpers, the original append-only store remains available to callers.
export function createUsageStore(file, { clock = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  warn = () => {}, io = { appendFile, mkdir, readFile }, prices, retention } = {}) {
  const pending = new Map();
  let queue = Promise.resolve();
  let warned = false;
  let cleanupPending = false, checkedDay = null;
  const warning = error => { if (!warned) { warned = true; warn(error); } };
  if (retention && (typeof retention.withFileLock !== 'function' || typeof retention.writeFileAtomic !== 'function')) throw TypeError('Retention requires atomic storage helpers');
  const retainedWrite = async batch => {
    await io.mkdir(dirname(file), { recursive: true });
    await retention.withFileLock(file, async () => {
      let contents = '';
      try { contents = await io.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let compacted;
      try { compacted = compactUsageLog(contents, batch, { now: clock(), timeZone }); }
      catch (error) {
        // Preserve damaged history and still persist new facts behind a delimiter.
        cleanupPending = true; warning(error);
        if (batch.length) await io.appendFile(file, '\n' + batch.map(event => JSON.stringify(event)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        for (const event of batch) pending.delete(event.id);
        return;
      }
      if (compacted.changed) await retention.writeFileAtomic(file, compacted.text, { mode: 0o600 });
      for (const event of batch) pending.delete(event.id);
      cleanupPending = false; checkedDay = dateKey(dateFormatter(timeZone), clock()); warned = false;
    });
  };
  const maintain = async () => {
    if (!retention) return;
    queue = queue.then(async () => {
      if (!pending.size && checkedDay === dateKey(dateFormatter(timeZone), clock())) return;
      try { await retainedWrite([...pending.values()]); }
      catch (error) { cleanupPending = true; warning(error); }
    });
    await queue;
  };
  return {
    maintain,
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
          if (retention) { await retainedWrite(batch); return; }
          await io.mkdir(dirname(file), { recursive: true });
          // Leading newline isolates a new record from an interrupted prior append.
          await io.appendFile(file, '\n' + batch.map(value => JSON.stringify(value)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
          for (const value of batch) pending.delete(value.id);
          warned = false;
        } catch (error) { cleanupPending = Boolean(retention); warning(error); }
      });
      await queue;
    },
    async snapshot() {
      await maintain();
      await queue;
      let contents = ''; let readable = true; let unreadableRecords = 0;
      let pendingAtRead = [];
      const read = async () => {
        try { contents = await io.readFile(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        pendingAtRead = [...pending.values()];
      };
      try {
        // Keep the file's archive and this instance's pending facts from the same
        // writer state: a concurrent commit may already have folded those ids away.
        if (retention) await retention.withFileLock(file, read);
        else await read();
      } catch (error) {
        readable = false; warning(error);
        // Read-only access can still show committed totals when locking is denied.
        try { contents = await io.readFile(file, 'utf8'); } catch {}
      }
      const document = readUsageDocument(contents);
      const events = document.events; unreadableRecords += document.unreadableRecords;
      events.push(...pendingAtRead);
      return summarizeUsage(events, { now: clock(), timeZone, persistent: readable && pending.size === 0, unreadableRecords,
        archive: document.archive,
        ...(retention ? { retention: { days: RETENTION_DAYS, retainedFrom: retentionStart(clock(), timeZone),
          archivedRequests: document.archive?.totals.requests ?? 0, cleanupPending } } : {}),
        ...(prices ? { pricing: await prices.status() } : {}) });
    },
  };
}
