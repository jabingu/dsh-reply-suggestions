import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { summarizeUsage } from '../src/usage.mjs';

async function mountUsage() {
  let exported, bundleSection, rowSection, panel, props, tree, cursor = 0, dirty = false, effectQueue = [];
  const hooks = [], pending = [], pricePending = [], schedulePending = [], intervals = new Map();
  let timerId = 0;
  function effect(fn, deps) {
    const i = cursor++, old = hooks[i];
    if (!old || deps.some((value, index) => value !== old.deps[index])) {
      hooks[i] = { deps, cleanup: old?.cleanup };
      effectQueue.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); });
    }
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useState(initial) {
      const i = cursor++; hooks[i] ??= { value: initial };
      return [hooks[i].value, value => { if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }];
    },
    useEffect: effect, useLayoutEffect: effect,
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { exported = factory(() => react); } } },
    AbortController, console,
    document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
    setInterval(fn) { intervals.set(++timerId, fn); return timerId; }, clearInterval(id) { intervals.delete(id); },
  });
  const ctx = {
    remote: { async $mount({ descriptors }) { assert.deepEqual(Array.from(descriptors, value => value.method), ['recommend', 'usage', 'updatePrices', 'setPriceSchedule']); },
      replySuggestions: {
        recommend() { throw Error('Statistics must not call a model'); },
        usage(signal) { return new Promise(resolve => pending.push({ signal, resolve })); },
        updatePrices(signal) { return new Promise(resolve => pricePending.push({ signal, resolve })); },
        setPriceSchedule(schedule, signal) { return new Promise(resolve => schedulePending.push({ schedule, signal, resolve })); },
      } },
    effect: fn => fn(), inject: (_names, fn) => fn(ctx), get: () => ctx.remote.replySuggestions,
    slots: { inject: (_name, fn) => fn(), register(options, component) {
      if (options.name === 'plugins.bundle.config') bundleSection = { options, component };
      if (options.name === 'plugins.detail.section') rowSection = { options, component };
    } },
  };
  await exported.apply(ctx);
  function select(subject) {
    const detail = rowSection.component({ subject, ...rowSection.options.inject() });
    if (subject.kind === 'bundle') {
      assert.equal(detail, null, 'The trailing detail slot must not duplicate the bundle panel');
      if (bundleSection.options.key !== subject.pkg.name) return null;
      panel = bundleSection.component;
      props = { view: 'page', ...bundleSection.options.inject() };
      return { type: panel, props };
    }
    const element = detail;
    if (element) { panel = element.type; props = element.props; }
    return element;
  }
  function flush() {
    let n = 0;
    do {
      if (++n > 15) throw Error('Usage render did not settle');
      dirty = false; cursor = 0; effectQueue = []; tree = panel(props);
      effectQueue.forEach(fn => fn());
    } while (dirty);
  }
  function find(key, value, node) {
    if (arguments.length === 2) node = tree;
    if (!node || typeof node !== 'object') return;
    if (node.props?.[key] === value) return node;
    for (const child of node.children ?? []) { const found = find(key, value, child); if (found) return found; }
  }
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
    : node && typeof node === 'object' ? (node.children ?? []).map(text).join(' ') : '';
  return { select, flush, pending, pricePending, schedulePending, intervals, find, text, get tree() { return tree; },
    tick() { for (const fn of intervals.values()) fn(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); } };
}
const sample = () => summarizeUsage([{ version: 1, id: 'one', at: '2026-10-14T01:00:00Z', status: 'complete',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 120 } },
  { version: 1, id: 'two', at: '2026-10-14T01:01:00Z', status: 'cancelled', usage: null }],
  { now: new Date('2026-10-14T02:00:00Z'), timeZone: 'Asia/Shanghai' });
const settle = () => new Promise(resolve => setImmediate(resolve));
const withPriceStatus = (value = sample()) => ({ ...value, pricing: { ...value.pricing, lastCheckedAt: null,
  lastAttemptAt: null, nextCheckAt: null, autoUpdate: true, intervalDays: 7, updating: false, persistent: true, error: null } });

test('Statistics show one selectable period and lifetime; all four ranges remain available without extra RPCs', async () => {
  const ui = await mountUsage();
  assert.equal(ui.select({ kind: 'bundle', pkg: { name: 'dsh-selection-group' } }), null);
  assert.equal(ui.pending.length, 0);
  assert.ok(ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } })); ui.flush();
  assert.equal(ui.pending.length, 1);
  ui.pending[0].resolve({ ok: true, value: sample() }); await settle(); ui.flush();
  for (const id of ['all', 'today']) assert.ok(ui.find('data-usage-period', id));
  for (const id of ['yesterday', 'week', 'month']) assert.equal(ui.find('data-usage-period', id), undefined);
  assert.match(ui.text(ui.find('data-usage-period', 'all')), /历史总量.*120/);
  const today = ui.text(ui.find('data-usage-period', 'today'));
  assert.match(today, /120/); assert.match(today, /Token \+ 未知/);
  assert.match(today, /输入（含缓存）100/); assert.match(today, /未返回用量 1 次/);
  assert.match(today, /估算费用.*（部分）/); assert.match(today, /历史 1 次按 Flash 假设估算/);
  assert.doesNotMatch(ui.text(ui.find('data-usage-cost', 'today')), /～/);
  assert.match(today, /历史 1 次按记录时间估算时段/);
  assert.match(today, /未计入费用 1 次/);
  assert.match(ui.text(ui.tree), /不代表实际账单或套餐扣费/);
  assert.equal(ui.find('href', 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing').props.rel, 'noreferrer');
  assert.match(ui.text(ui.tree), /之前的历史用量无法补回/);
  for (const id of ['yesterday', 'week', 'month', 'today']) {
    ui.find('data-usage-window', '').props.onChange({ target: { value: id } }); ui.flush();
    assert.ok(ui.find('data-usage-period', id));
    assert.equal(ui.find('data-usage-window', '').props.value, id);
    for (const other of ['today', 'yesterday', 'week', 'month']) {
      if (other !== id) assert.equal(ui.find('data-usage-period', other), undefined);
    }
    assert.match(ui.text(ui.find('data-usage-period', id)), id === 'yesterday' ? /0 Token/ : /120 Token/);
    assert.match(ui.text(ui.find('data-usage-period', 'all')), /历史总量.*120/);
    assert.equal(ui.pending.length, 1); assert.equal(ui.pricePending.length, 0); assert.equal(ui.schedulePending.length, 0);
  }
  assert.match(ui.text(ui.find('data-usage-period', 'today')), /估算费用.*（部分）/);
  assert.ok(ui.select({ kind: 'row', row: { moduleName: 'dsh-reply-suggestions' } })); ui.unmount();
});

test('Manual/periodic refresh use the usage RPC and disposal aborts a late response', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  ui.pending[0].resolve({ ok: true, value: sample() }); await settle(); ui.flush();
  ui.find('type', 'button').props.onClick(); assert.equal(ui.pending.length, 2);
  ui.pending[1].resolve({ ok: true, value: sample() }); await settle(); ui.flush();
  ui.tick(); assert.equal(ui.pending.length, 3);
  ui.unmount(); assert.equal(ui.intervals.size, 0); assert.equal(ui.pending[2].signal.aborted, true);
  ui.pending[2].resolve({ ok: true, value: null }); await settle();
});

test('The detail page explains the 30-day detail limit and cumulative history; cleanup failures stay visible', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  const value = sample(); value.retention = { days: 30, retainedFrom: '2026-09-15', archivedRequests: 1, cleanupPending: true };
  ui.pending[0].resolve({ ok: true, value }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /逐条明细保留最近 30 天/); assert.match(ui.text(ui.tree), /历史总量不减少/);
  assert.match(ui.text(ui.tree), /已汇总 1 次/); assert.match(ui.text(ui.tree), /明细清理暂未完成/);
  assert.match(ui.text(ui.find('data-usage-period', 'all')), /历史总量.*120/); ui.unmount();
});

test('A stale Host range is never silently displayed as the lower single amount', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  const value = sample();
  for (const period of [...value.periods, value.lifetime]) {
    delete period.cost.cny; period.cost.maxCny = period.cost.minCny * 2;
  }
  ui.pending[0].resolve({ ok: true, value }); await settle(); ui.flush();
  const cost = ui.text(ui.find('data-usage-cost', 'today'));
  assert.match(cost, /请重启 DSH/); assert.doesNotMatch(cost, /¥|～/); ui.unmount();
});

test('Unknown calendar years do not display unknown paid requests as free', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  const value = summarizeUsage([{ version: 1, id: 'unknown', at: '2027-01-04T02:00:00Z', status: 'complete',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 } }],
  { now: new Date('2027-01-04T03:00:00Z'), timeZone: 'UTC' });
  ui.pending[0].resolve({ ok: true, value }); await settle(); ui.flush();
  assert.match(ui.text(ui.find('data-usage-cost', 'today')), /暂无可估算记录/);
  assert.match(ui.text(ui.tree), /节假日日历覆盖 2026 年/); ui.unmount();
});

test('RPC and persistence failures are shown without invented usage', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  ui.pending[0].resolve({ ok: false, error: { message: 'unavailable' } }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /用量暂时无法读取/); assert.equal(ui.find('data-usage-period', 'today'), undefined);
  ui.find('type', 'button').props.onClick();
  ui.pending[1].resolve({ ok: true, value: { ...sample(), persistent: false, unreadableRecords: 1 } }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /无法完整读写/); assert.match(ui.text(ui.tree), /部分记录无法读取/); ui.unmount();
});

test('The price button uses only its RPC, displays automatic checks, and preserves costs on failures', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  ui.pending[0].resolve({ ok: true, value: withPriceStatus() }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /每 7 天/); assert.match(ui.text(ui.tree), /尚未联网检查/);
  ui.find('data-update-prices', '').props.onClick(); ui.flush();
  assert.equal(ui.pricePending.length, 1); assert.equal(ui.pending.length, 1);
  ui.tick(); assert.equal(ui.pending.length, 1); // No stale usage response can overwrite the result of this update.
  assert.equal(ui.find('data-update-prices', '').props.disabled, true);
  const updated = withPriceStatus(); updated.pricing.lastCheckedAt = '2026-10-14T03:00:00Z';
  updated.pricing.lastAttemptAt = updated.pricing.lastCheckedAt; updated.pricing.nextCheckAt = '2026-10-21T03:00:00Z';
  ui.pricePending[0].resolve({ ok: true, value: updated }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /已检查官方价格/); assert.match(ui.text(ui.tree), /下次检查/);
  ui.find('data-update-prices', '').props.onClick();
  const failed = { ...updated, pricing: { ...updated.pricing, error: '网络不可用或请求超时' } };
  ui.pricePending[1].resolve({ ok: true, value: failed }); await settle(); ui.flush();
  assert.match(ui.text(ui.tree), /网络不可用或请求超时/); assert.match(ui.text(ui.tree), /继续使用已有价格/);
  assert.ok(ui.find('data-usage-cost', 'today'));
  ui.find('data-update-prices', '').props.onClick(); ui.unmount();
  assert.equal(ui.pricePending[2].signal.aborted, true);
  ui.pricePending[2].resolve({ ok: true, value: updated }); await settle();
});

test('Schedule options save immediately, keep the old value until acknowledged and remain unchanged on failure', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  ui.pending[0].resolve({ ok: true, value: withPriceStatus() }); await settle(); ui.flush();
  const select = () => ui.find('data-price-schedule', '');
  assert.equal(select().props.value, '7');
  assert.deepEqual(select().children.filter(value => value?.type === 'option').map(value => value.props.value), ['1', '3', '7', '30', 'manual']);
  select().props.onChange({ target: { value: '3' } }); ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.schedulePending[0].schedule)), { autoUpdate: true, intervalDays: 3 });
  assert.equal(select().props.disabled, true); assert.equal(select().props.value, '7');
  ui.tick(); assert.equal(ui.pending.length, 1); assert.equal(ui.pricePending.length, 0);
  const saved = withPriceStatus(); saved.pricing.intervalDays = 3;
  ui.schedulePending[0].resolve({ ok: true, value: saved }); await settle(); ui.flush();
  assert.equal(select().props.value, '3'); assert.match(ui.text(ui.tree), /已保存更新周期/);
  select().props.onChange({ target: { value: 'manual' } });
  const manual = { ...saved, pricing: { ...saved.pricing, autoUpdate: false } };
  ui.schedulePending[1].resolve({ ok: true, value: manual }); await settle(); ui.flush();
  assert.equal(select().props.value, 'manual'); assert.match(ui.text(ui.tree), /自动检查已关闭/);
  assert.equal(ui.find('data-update-prices', '').props.disabled, false);
  select().props.onChange({ target: { value: '1' } });
  ui.schedulePending[2].resolve({ ok: false, error: { message: 'save failed' } }); await settle(); ui.flush();
  assert.equal(select().props.value, 'manual'); assert.match(ui.text(ui.tree), /保存失败，保留原来的设置/);
  select().props.onChange({ target: { value: '30' } }); ui.unmount();
  assert.equal(ui.schedulePending[3].signal.aborted, true);
  ui.schedulePending[3].resolve({ ok: true, value: saved }); await settle();
});

test('A configured custom day interval has a matching current selection', async () => {
  const ui = await mountUsage(); ui.select({ kind: 'bundle', pkg: { name: 'dsh-reply-suggestions' } }); ui.flush();
  const value = withPriceStatus(); value.pricing.intervalDays = 17;
  ui.pending[0].resolve({ ok: true, value }); await settle(); ui.flush();
  assert.equal(ui.find('data-price-schedule', '').props.value, '17');
  assert.ok(ui.find('value', '17')); ui.unmount();
});
