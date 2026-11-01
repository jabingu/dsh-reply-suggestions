const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = require('react');

// A per-composer lease survives component overlap and even a second copy of the client bundle.
// Each placeholder remembers its own inline value so cleanup restores only what we changed.
const placeholderLease = Symbol.for('dsh-reply-suggestions.placeholder-lease');
function suppressPlaceholder(card, root) {
  let shared = card[placeholderLease];
  if (!shared || shared.mode !== 'exclusive') {
    // Retain the original placeholder styles when replacing an older client guard.
    const nodes = shared?.nodes ?? new Map();
    shared?.observer.disconnect();
    if (shared) for (const oldRoot of card.querySelectorAll('[data-reply-suggestion-plugin]')) {
      if (oldRoot !== root) oldRoot.style.setProperty('visibility', 'hidden', 'important');
    }
    shared = { mode: 'exclusive', owners: new Set(), active: null, nodes };
    const restore = node => {
      const before = shared.nodes.get(node);
      if (node.style.getPropertyValue('visibility') === 'hidden' && node.style.getPropertyPriority('visibility') === 'important') {
        if (before.value) node.style.setProperty('visibility', before.value, before.priority);
        else node.style.removeProperty('visibility');
      }
      shared.nodes.delete(node);
    };
    const sync = () => {
      if (!shared.active || card[placeholderLease] !== shared) return;
      for (const owner of shared.owners) {
        if (owner !== shared.active && (owner.root.style.getPropertyValue('visibility') !== 'hidden'
          || owner.root.style.getPropertyPriority('visibility') !== 'important')) owner.root.style.setProperty('visibility', 'hidden', 'important');
      }
      const nodes = new Set(card.querySelectorAll('[data-composer-placeholder]'));
      for (const node of shared.nodes.keys()) if (!nodes.has(node)) restore(node);
      for (const node of nodes) {
        if (!shared.nodes.has(node)) shared.nodes.set(node, { value: node.style.getPropertyValue('visibility'),
          priority: node.style.getPropertyPriority('visibility') });
        if (node.style.getPropertyValue('visibility') !== 'hidden' || node.style.getPropertyPriority('visibility') !== 'important') {
          node.style.setProperty('visibility', 'hidden', 'important');
        }
      }
      if (!card.hasAttribute('data-reply-suggestion-active')) card.setAttribute('data-reply-suggestion-active', '');
    };
    shared.restore = restore; shared.sync = sync;
    shared.observer = new MutationObserver(sync);
    shared.observer.observe(card, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'data-composer-placeholder', 'data-reply-suggestion-active'] });
    card[placeholderLease] = shared;
  }
  const owner = { root, visibility: root.style.getPropertyValue('visibility'), priority: root.style.getPropertyPriority('visibility') };
  shared.active = owner; shared.owners.add(owner); shared.sync();
  return () => {
    shared.owners.delete(owner);
    if (root.style.getPropertyValue('visibility') === 'hidden' && root.style.getPropertyPriority('visibility') === 'important') {
      if (owner.visibility) root.style.setProperty('visibility', owner.visibility, owner.priority);
      else root.style.removeProperty('visibility');
    }
    if (shared.active !== owner || card[placeholderLease] !== shared) return;
    shared.active = null;
    shared.observer.disconnect();
    for (const node of shared.nodes.keys()) shared.restore(node);
    card.removeAttribute('data-reply-suggestion-active');
    delete card[placeholderLease];
  };
}

function GhostReply({ sessionId, useInput, useSession, useConversation, useProjection, inputActions, generate }) {
  const input = useInput(value => value);
  const running = useSession(value => value.running);
  const removed = useSession(value => value.removed);
  const selectedModel = useProjection('modelSelection', value => value?.next ?? value?.lastUsed);
  const candidate = useConversation(value => selectReply(value.views.get('chat')?.legacy.nodes ?? [], sessionId, selectedModel),
    (a, b) => a?.replyId === b?.replyId && a?.assistant === b?.assistant && a?.user === b?.user && a?.provider === b?.provider && a?.model === b?.model);
  const [suggestion, setSuggestion] = useState('');
  const [dismissed, setDismissed] = useState(null);
  const [geometry, setGeometry] = useState(null);
  const anchor = useRef(null);
  const live = useRef(null);
  const request = useRef(null);
  const replyKey = candidate ? JSON.stringify([sessionId, candidate.replyId, candidate.provider, candidate.model]) : null;
  const [resultKey, setResultKey] = useState(null);
  const available = canAccept({ suggestion: 'ready', input, running, removed, editable: geometry?.editable });
  const visible = resultKey === replyKey && dismissed !== replyKey && canAccept({
    suggestion, input, running, removed, editable: geometry?.editable,
  });
  live.current = { suggestion: visible ? suggestion : '', input, running, removed,
    editable: geometry?.editable, inputActions, replyKey };

  useEffect(() => {
    setSuggestion(''); setResultKey(null);
    if (!candidate || running || removed) return;
    const controller = new AbortController();
    const job = { controller, candidate, replyKey, started: false };
    request.current = job;
    return () => { controller.abort(); if (request.current === job) request.current = null; };
  }, [sessionId, replyKey, candidate?.assistant, candidate?.user, running, removed, generate]);

  useEffect(() => {
    const job = request.current;
    if (!available || dismissed === replyKey || !job || job.started) return;
    // Wait for a usable empty composer. Typing cancels only the timer, never a paid request
    // already in flight; that result can still be used if the draft is cleared later.
    const timer = setTimeout(() => {
      if (request.current !== job || job.started || job.controller.signal.aborted) return;
      job.started = true;
      generate(job.candidate, job.controller.signal).then(text => {
        if (!job.controller.signal.aborted && request.current === job) { setSuggestion(normalizeSuggestion(text)); setResultKey(job.replyKey); }
      }).catch(error => {
        if (!job.controller.signal.aborted) console.warn('[reply-suggestions] Recommendation unavailable:', error?.message ?? 'unknown error');
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [sessionId, replyKey, candidate?.assistant, candidate?.user, running, removed, generate, available, dismissed]);

  useLayoutEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]');
    // Lexical sets contenteditable after child layout effects; the render-time marker exists earlier.
    const editor = card?.querySelector('[data-composer-input], [contenteditable]');
    const overlay = anchor.current?.closest('[data-composer-overlay]') ?? card;
    if (!card || !editor || !overlay) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const rect = editor.getBoundingClientRect();
      const origin = overlay.getBoundingClientRect();
      const css = getComputedStyle(editor);
      const next = { left: rect.left - origin.left + parseFloat(css.paddingLeft || '0'),
        top: rect.top - origin.top + parseFloat(css.paddingTop || '0'),
        width: Math.max(0, rect.width - parseFloat(css.paddingLeft || '0') - parseFloat(css.paddingRight || '0')),
        font: css.font, lineHeight: css.lineHeight,
        editable: editor.getAttribute('contenteditable') === 'true' && editor.getAttribute('aria-disabled') !== 'true' };
      setGeometry(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    measure();
    const resize = new ResizeObserver(measure); resize.observe(editor); resize.observe(card);
    const mutation = new MutationObserver(measure); mutation.observe(editor, { attributes: true });
    const uninstall = installAcceptance(editor, () => ({ ...live.current,
      suggestion: card[placeholderLease]?.active?.root === anchor.current ? live.current.suggestion : '',
      editable: editor.getAttribute('contenteditable') === 'true' && editor.getAttribute('aria-disabled') !== 'true',
    }), () => {
      const state = live.current;
      // Revision-guarded insertion preserves undo and refuses a concurrent draft edit.
      const span = state.inputActions.captureInsertion();
      if (span.start !== 0 || span.end !== 0 || span.draftRev !== state.input.draftRev) return;
      if (state.inputActions.insertText(state.suggestion, span)) {
        setDismissed(state.replyKey);
      }
    }, () => setDismissed(live.current.replyKey));
    return () => { disposed = true; resize.disconnect(); mutation.disconnect(); uninstall(); };
  }, [sessionId]);

  useLayoutEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]');
    if (!card || !visible) return;
    return suppressPlaceholder(card, anchor.current);
  }, [visible, sessionId]);

  return h('span', { ref: anchor, 'data-reply-suggestion-plugin': '' },
    visible && h('span', {
      className: 'dsh-reply-suggestion-ghost', 'aria-hidden': true,
      style: { position: 'absolute', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        left: geometry.left, top: geometry.top, width: geometry.width, font: geometry.font, lineHeight: geometry.lineHeight,
        color: 'var(--dsw-alias-label-secondary, #999)', opacity: 0.55 },
    }, suggestion),
    h('span', { className: 'dsh-reply-suggestion-sr', role: 'status', 'aria-live': 'polite',
      // Keep the announcement hidden even when page navigation discards head styles.
      style: { position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 },
    }, visible ? `推荐回复：${suggestion} 按 Enter 填入，按 Escape 隐藏。` : ''));
}

function UsagePanel({ getUsage, updatePrices, setPriceSchedule }) {
  const [snapshot, setSnapshot] = useState(null);
  const [usageWindow, setUsageWindow] = useState('today');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [priceLoading, setPriceLoading] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [priceMessage, setPriceMessage] = useState('');
  const refresh = useRef(null);
  const update = useRef(null);
  const schedule = useRef(null);
  useEffect(() => {
    let disposed = false;
    let controller;
    let priceController;
    const read = () => {
      if (priceController) return;
      controller?.abort();
      const current = controller = new AbortController();
      setLoading(true);
      getUsage(current.signal).then(value => {
        if (!disposed && !current.signal.aborted) { setSnapshot(validateUsageSnapshot(value)); setError(false); }
      }).catch(() => {
        if (!disposed && !current.signal.aborted) setError(true);
      }).finally(() => {
        if (!disposed && !current.signal.aborted) setLoading(false);
      });
    };
    refresh.current = read;
    const mutate = async (request, kind) => {
      if (!request || priceController) return;
      const current = priceController = new AbortController();
      controller?.abort(); setLoading(false); setPriceLoading(kind === 'prices'); setScheduleLoading(kind === 'schedule'); setPriceMessage('');
      try {
        const value = validateUsageSnapshot(await request(current.signal));
        if (!disposed && !current.signal.aborted) {
          setSnapshot(value); setError(false);
          setPriceMessage(kind === 'schedule' ? '已保存更新周期。'
            : value.pricing?.error ? '本次更新未完成，继续使用已有价格。' : '已检查官方价格，新请求使用当前价格。');
        }
      } catch {
        if (!disposed && !current.signal.aborted) setPriceMessage(kind === 'schedule'
          ? '更新周期保存失败，保留原来的设置。' : '价格更新暂时无法完成，继续使用已有价格。');
      } finally {
        if (!disposed && !current.signal.aborted) { setPriceLoading(false); setScheduleLoading(false); }
        priceController = null;
      }
    };
    update.current = () => mutate(updatePrices, 'prices');
    schedule.current = value => setPriceSchedule && mutate(signal => setPriceSchedule(value, signal), 'schedule');
    read();
    const timer = setInterval(read, 15000);
    return () => { disposed = true; controller?.abort(); priceController?.abort(); clearInterval(timer); refresh.current = null; update.current = null; schedule.current = null; };
  }, [getUsage, updatePrices, setPriceSchedule]);
  const format = value => Number(value).toLocaleString('zh-CN');
  const labels = { all: '历史总量', today: '今天', yesterday: '昨天', week: '近 7 天', month: '近 30 天' };
  const visiblePeriods = snapshot ? [snapshot.periods.find(period => period.id === usageWindow),
    ...(snapshot.lifetime ? [snapshot.lifetime] : [])] : [];
  const timestamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: snapshot.timeZone });
  const note = { fontSize: '12px', opacity: 0.7, margin: '6px 0', lineHeight: 1.6 };
  return h('section', { 'data-reply-usage': '', style: { marginTop: '18px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
      h('h3', { style: { margin: '0 0 12px', fontSize: '16px', fontWeight: 600 } }, '推荐 Token 用量'),
      h('button', { type: 'button', disabled: loading, onClick: () => refresh.current?.(),
        style: { color: 'inherit', background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
          borderRadius: '6px', padding: '4px 10px', cursor: loading ? 'default' : 'pointer' } }, loading ? '读取中…' : '刷新')),
    snapshot && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' } },
      ...visiblePeriods.map(period => h('div', { key: period.id === 'all' ? 'all' : 'window', 'data-usage-period': period.id,
        style: { padding: '14px', border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: '10px' } },
        period.id === 'all' ? h('div', { style: { fontSize: '13px', opacity: 0.75 } }, labels[period.id])
          : h('select', { 'data-usage-window': '', 'aria-label': '统计时间范围', value: usageWindow,
            onChange: event => { if (USAGE_PERIODS.includes(event.target.value)) setUsageWindow(event.target.value); },
            style: { fontSize: '13px', color: 'inherit', background: 'transparent', borderRadius: '6px',
              border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', padding: '3px 7px' } },
            ...USAGE_PERIODS.map(id => h('option', { key: id, value: id, style: { color: 'CanvasText', background: 'Canvas' } }, labels[id]))),
        h('div', { style: { fontSize: '24px', fontWeight: 600, margin: '7px 0' } }, formatTokens(period.totalTokens),
          h('span', { style: { fontSize: '12px', fontWeight: 400, marginLeft: '5px' } }, period.unknownRequests ? 'Token + 未知' : 'Token')),
        h('p', { style: note }, `输入（含缓存）${formatTokens(period.inputTokens)} · 输出 ${formatTokens(period.outputTokens)}`),
        period.cost && h('p', { 'data-usage-cost': period.id, style: { ...note, opacity: 0.9 } },
          period.cost.pricedRequests || period.requests === 0
            ? period.cost.cny !== undefined || period.cost.minCny === period.cost.maxCny
              ? `估算费用 ${formatCost(period.cost.cny ?? period.cost.minCny)}${period.cost.unpricedRequests ? '（部分）' : ''}`
              : '估算费用：请重启 DSH 以更新计费'
            : '估算费用：暂无可估算记录'),
        period.cost?.assumedRequests > 0 && h('p', { style: note }, `历史 ${format(period.cost.assumedRequests)} 次按 Flash 假设估算`),
        period.cost?.legacyTimeRequests > 0 && h('p', { style: note }, `历史 ${format(period.cost.legacyTimeRequests)} 次按记录时间估算时段`),
        period.cost?.unpricedRequests > 0 && h('p', { style: note }, `未计入费用 ${format(period.cost.unpricedRequests)} 次（模型、价格、用量或节假日日历未知）`),
        h('p', { style: note }, `请求 ${format(period.requests)} 次 · 未返回用量 ${format(period.unknownRequests)} 次`),
        (period.failedRequests + period.cancelledRequests > 0) && h('p', { style: note },
          `失败 ${format(period.failedRequests)} 次 · 取消 ${format(period.cancelledRequests)} 次`)))),
    !snapshot && !error && h('p', { style: note, role: 'status' }, '正在读取用量…'),
    error && h('p', { style: note, role: 'status' }, '用量暂时无法读取，请稍后刷新。'),
    snapshot && h('div', { style: { marginTop: '10px' } },
      h('p', { style: note }, `仅统计本插件的推荐请求；缓存命中不重复计数。历史总量包含开始记录以来的全部有效记录；近 7/30 天含今天，按 ${snapshot.timeZone} 的自然日汇总。`),
      snapshot.pricing && h('p', { style: note },
        `费用按每次请求的北京时间、节假日及当时价格计算，不代表实际账单或套餐扣费。价格核对：${snapshot.pricing.checkedAt}。`,
        h('a', { href: snapshot.pricing.source, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '官方价格表')),
      snapshot.pricing?.holidayYears && h('p', { style: note },
        `节假日日历覆盖 ${snapshot.pricing.holidayYears.join('、')} 年；未覆盖年份若无法确定时段，该请求费用标为未知。`),
      updatePrices && snapshot.pricing && h('div', { 'data-price-updates': '', style: { marginTop: '10px' } },
        setPriceSchedule && h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', margin: '0 12px 8px 0', fontSize: '13px' } },
          '自动更新周期',
          h('select', { 'data-price-schedule': '', value: snapshot.pricing.autoUpdate ? String(snapshot.pricing.intervalDays) : 'manual',
            disabled: scheduleLoading || priceLoading || snapshot.pricing.updating,
            onChange: event => schedule.current?.({ autoUpdate: event.target.value !== 'manual',
              intervalDays: event.target.value === 'manual' ? snapshot.pricing.intervalDays : Number(event.target.value) }),
            style: { color: 'inherit', background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
              borderRadius: '6px', padding: '4px 8px' } },
            ...[['1', '每天'], ['3', '每 3 天'], ['7', '每周（7 天）'], ['30', '每 30 天'], ['manual', '仅手动更新']]
              .map(([value, label]) => h('option', { key: value, value, style: { color: 'CanvasText', background: 'Canvas' } }, label)),
            ![1, 3, 7, 30].includes(snapshot.pricing.intervalDays) && h('option', { value: String(snapshot.pricing.intervalDays) }, `每 ${snapshot.pricing.intervalDays} 天（当前设置）`))),
        h('button', { type: 'button', 'data-update-prices': '', disabled: scheduleLoading || priceLoading || snapshot.pricing.updating,
          onClick: () => update.current?.(), style: { color: 'inherit', background: 'transparent',
            border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: '6px', padding: '4px 10px' } },
          priceLoading || snapshot.pricing.updating ? '正在更新价格…' : '更新价格'),
        scheduleLoading && h('p', { style: note, role: 'status' }, '正在保存更新周期…'),
        h('p', { style: note }, snapshot.pricing.autoUpdate
          ? `自动检查：每 ${snapshot.pricing.intervalDays} 天；DSH 关闭期间暂停，启动后补检查。`
          : '自动检查已关闭，可手动更新价格。'),
        h('p', { style: note }, snapshot.pricing.lastCheckedAt
          ? `上次成功检查：${timestamp(snapshot.pricing.lastCheckedAt)}` : '尚未联网检查，当前使用插件内置价格。'),
        snapshot.pricing.nextCheckAt && h('p', { style: note }, `下次检查不早于：${timestamp(snapshot.pricing.nextCheckAt)}${snapshot.pricing.error ? '（失败后重试）' : ''}`),
        snapshot.pricing.error && h('p', { style: note, role: 'status' }, `${snapshot.pricing.error}；继续使用已有价格。`),
        snapshot.pricing.persistent === false && h('p', { style: note, role: 'status' }, '价格记录无法完整读写；本次价格可能仅在当前运行期间有效。'),
        priceMessage && h('p', { style: note, role: 'status' }, priceMessage)),
      h('p', { style: note }, snapshot.trackingSince
        ? `开始记录：${timestamp(snapshot.trackingSince)}。之前的历史用量无法补回。`
        : '从本版本起记录，暂无推荐请求；之前的历史用量无法补回。'),
      h('p', { style: note }, `更新于 ${timestamp(snapshot.updatedAt)}；页面打开时每 15 秒刷新，不调用模型。`),
      !snapshot.persistent && h('p', { style: note, role: 'status' }, '记录暂时无法完整读写，统计可能不完整；未保存的记录重启后可能丢失。'),
      snapshot.unreadableRecords > 0 && h('p', { style: note, role: 'status' }, '部分记录无法读取，统计可能不完整。')));
}

function UsageSection({ subject, getUsage, updatePrices, setPriceSchedule }) {
  const matches = (subject?.kind === 'bundle' && subject.pkg?.name === PACKAGE)
    || (subject?.kind === 'row' && subject.row?.moduleName === PACKAGE);
  return matches ? h(UsagePanel, { getUsage, updatePrices, setPriceSchedule }) : null;
}

exports.inject = ['slots', 'remote', 'uiConversation'];
exports.apply = async function apply(ctx) {
  await ctx.remote.$mount({ package: PACKAGE, descriptors: [descriptor(), usageDescriptor(), updatePricesDescriptor(), setPriceScheduleDescriptor()] });
  ctx.inject(['remote.replySuggestions'], scope => {
    const remote = scope.get('remote.replySuggestions');
    const generate = async (input, signal) => {
      const result = await remote.recommend(input, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const getUsage = async signal => {
      const result = await remote.usage(signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const updatePrices = async signal => {
      const result = await remote.updatePrices(signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const setPriceSchedule = async (schedule, signal) => {
      const result = await remote.setPriceSchedule(schedule, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay', id: PACKAGE,
      inject: () => ({ generate }),
    }, GhostReply));
    scope.slots.inject('plugins.detail.section', () => scope.slots.register({
      name: 'plugins.detail.section', id: `${PACKAGE}.usage`, inject: () => ({ getUsage, updatePrices, setPriceSchedule }),
    }, UsageSection));
  });
};
