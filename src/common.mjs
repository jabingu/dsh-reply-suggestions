export const PACKAGE = 'dsh-reply-suggestions';
export const SERVICE = 'replySuggestions';
export const CONTEXT_LIMITS = { user: 400, assistant: 1200 };

// Keep the topic and the closing next step; omit code locally, without a summary model call.
export function compactContext(text, limit) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; kept.push('[代码略]'); }
    else kept.push(line);
  }
  const characters = Array.from(kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (characters.length <= limit) return characters.join('');
  const separator = '\n[中间略]\n';
  const available = limit - separator.length;
  const head = Math.floor(available / 3);
  return characters.slice(0, head).join('') + separator + characters.slice(-(available - head)).join('');
}

export function recommendationContext(input) {
  return { user: compactContext(input.user, CONTEXT_LIMITS.user),
    assistant: compactContext(input.assistant, CONTEXT_LIMITS.assistant) };
}

export function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid recommendation input');
  const allowed = new Set(['sessionId', 'replyId', 'provider', 'model', 'user', 'assistant']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Unknown recommendation field');
  for (const key of allowed) {
    if (typeof value[key] !== 'string') throw new TypeError(`Missing ${key}`);
  }
  for (const key of ['sessionId', 'replyId', 'provider', 'model']) {
    if (!value[key].trim() || value[key].length > 512) throw new TypeError(`Invalid ${key}`);
  }
  if (!value.assistant.trim() || value.assistant.length > 12000 || value.user.length > 2000) throw new TypeError('Invalid context size');
  return { ...value };
}

export function normalizeSuggestion(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (text.startsWith('{')) {
    try { text = JSON.parse(text).suggestion ?? ''; } catch { return ''; }
  }
  if (typeof text !== 'string') return '';
  text = text.replace(/^```(?:json|text)?\s*|\s*```$/g, '').replace(/^["“]|["”]$/g, '').trim();
  if (!text || /[\r\n]/.test(text) || text.length > 100 || text.startsWith('/')) return '';
  return text;
}

export function descriptor() {
  return {
    id: `${PACKAGE}#recommend`, service: SERVICE, namespace: SERVICE, method: 'recommend',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#Input`, create: () => ({ parse: validateInput }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Suggestion`, create: () => ({
      parse: value => { if (typeof value !== 'string' || value.length > 100) throw new TypeError('Invalid suggestion'); return value; },
    }) },
  };
}

export const USAGE_PERIODS = ['today', 'yesterday', 'week', 'month'];
export const USAGE_COUNTERS = ['requests', 'unknownRequests', 'failedRequests', 'cancelledRequests',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

// DSH's inputTokens excludes separately reported cache tokens. Prefer its authoritative total.
export function normalizeUsage(raw) {
  if (!raw || !tokenCount(raw.inputTokens) || !tokenCount(raw.outputTokens)) return null;
  const cacheReadTokens = raw.cacheReadTokens ?? 0;
  const cacheWriteTokens = raw.cacheWriteTokens ?? 0;
  if (!tokenCount(cacheReadTokens) || !tokenCount(cacheWriteTokens)) return null;
  const totalTokens = raw.totalTokens ?? (raw.inputTokens + raw.outputTokens + cacheReadTokens + cacheWriteTokens);
  if (!tokenCount(totalTokens) || totalTokens < raw.outputTokens) return null;
  return { inputTokens: totalTokens - raw.outputTokens, outputTokens: raw.outputTokens,
    cacheReadTokens, cacheWriteTokens, totalTokens };
}

function validateUsagePeriod(period, id) {
  if (period?.id !== id || USAGE_COUNTERS.some(key => !tokenCount(period[key]))
    || period.unknownRequests > period.requests || period.failedRequests + period.cancelledRequests > period.requests
    || period.inputTokens + period.outputTokens !== period.totalTokens) throw new TypeError('Invalid usage period');
  if (period.cost !== undefined) {
    const cost = period.cost;
    if (!cost || !Number.isFinite(cost.minCny) || !Number.isFinite(cost.maxCny)
      || cost.minCny < 0 || cost.maxCny < cost.minCny
      || ['pricedRequests', 'assumedRequests', 'unpricedRequests'].some(key => !tokenCount(cost[key]))
      || cost.pricedRequests + cost.unpricedRequests !== period.requests
      || cost.assumedRequests > cost.pricedRequests) throw new TypeError('Invalid cost estimate');
    if (cost.cny !== undefined && (!Number.isFinite(cost.cny) || cost.cny < 0
      || cost.minCny !== cost.cny || cost.maxCny !== cost.cny)) throw new TypeError('Invalid single cost estimate');
    if (cost.legacyTimeRequests !== undefined && (!tokenCount(cost.legacyTimeRequests)
      || cost.legacyTimeRequests > cost.pricedRequests)) throw new TypeError('Invalid legacy time count');
  }
}

export function validateUsageSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid usage snapshot');
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 80 || !value.timeZone
    || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.trackingSince !== null && !Number.isFinite(Date.parse(value.trackingSince)))
    || typeof value.persistent !== 'boolean' || !tokenCount(value.unreadableRecords)
    || !Array.isArray(value.periods) || value.periods.length !== 4) throw new TypeError('Invalid usage metadata');
  for (let i = 0; i < USAGE_PERIODS.length; i++) {
    validateUsagePeriod(value.periods[i], USAGE_PERIODS[i]);
  }
  if (value.lifetime !== undefined) validateUsagePeriod(value.lifetime, 'all');
  if (value.retention !== undefined && (value.retention?.days !== 30
    || typeof value.retention.retainedFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.retention.retainedFrom)
    || !tokenCount(value.retention.archivedRequests) || value.retention.archivedRequests > (value.lifetime?.requests ?? 0)
    || typeof value.retention.cleanupPending !== 'boolean')) throw TypeError('Invalid retention metadata');
  if (value.pricing?.holidayYears !== undefined && (!Array.isArray(value.pricing.holidayYears)
    || value.pricing.holidayYears.some(year => !Number.isInteger(year) || year < 2000 || year > 9999))) throw new TypeError('Invalid holiday calendar metadata');
  if (value.pricing !== undefined && (value.pricing?.currency !== 'CNY'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.pricing.checkedAt)
    || value.pricing.source !== 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
    || value.periods.some(period => !period.cost) || (value.lifetime !== undefined && !value.lifetime.cost))) throw new TypeError('Invalid pricing metadata');
  if (value.pricing?.lastCheckedAt !== undefined) {
    const pricing = value.pricing;
    if (['lastCheckedAt', 'lastAttemptAt', 'nextCheckAt'].some(key => pricing[key] !== null
      && (typeof pricing[key] !== 'string' || !Number.isFinite(Date.parse(pricing[key]))))
      || typeof pricing.autoUpdate !== 'boolean' || typeof pricing.updating !== 'boolean' || typeof pricing.persistent !== 'boolean'
      || !Number.isInteger(pricing.intervalDays) || pricing.intervalDays < 1 || pricing.intervalDays > 30
      || (pricing.error !== null && (typeof pricing.error !== 'string' || pricing.error.length > 200))) throw new TypeError('Invalid price update status');
  }
  return value;
}

export function formatTokens(value) {
  if (value < 1000) return String(value);
  let divisor = value >= 1e6 ? 1e6 : 1000;
  // Promote a rounded 1000K to 1M rather than displaying an oversized K value.
  if (divisor === 1000 && Number((value / divisor).toFixed(2)) >= 1000) divisor = 1e6;
  return (value / divisor).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false })
    + (divisor === 1e6 ? 'M' : 'K');
}

export function formatCost(value) {
  if (value === 0) return '¥0';
  if (value < 0.000001) return '< ¥0.000001';
  return '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function usageDescriptor() {
  return { id: `${PACKAGE}#usage`, service: SERVICE, namespace: SERVICE, method: 'usage',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#UsageSnapshot`,
      create: () => ({ parse: validateUsageSnapshot }) } };
}

export function updatePricesDescriptor() {
  const result = usageDescriptor();
  return { ...result, id: `${PACKAGE}#updatePrices`, method: 'updatePrices' };
}

export function validatePriceSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || typeof value.autoUpdate !== 'boolean'
    || !Number.isInteger(value.intervalDays) || value.intervalDays < 1 || value.intervalDays > 30) {
    throw new TypeError('Invalid price update schedule');
  }
  return { autoUpdate: value.autoUpdate, intervalDays: value.intervalDays };
}

export function setPriceScheduleDescriptor() {
  return { ...usageDescriptor(), id: `${PACKAGE}#setPriceSchedule`, method: 'setPriceSchedule',
    parameters: [{ name: 'schedule', wire: 'schedule', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#PriceSchedule`, create: () => ({ parse: validatePriceSchedule }),
    } }] };
}

export function selectReply(nodes, sessionId, selectedModel) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind === 'user' || node.kind === 'steering') return null;
    if (node.kind !== 'assistant') continue;
    if (node.interrupted || node.blocks.some(block => block.kind === 'tool-call')) return null;
    const assistant = node.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n').trim();
    const model = node.requestConfig ?? node.providerMetadata ?? selectedModel;
    if (!assistant || !model?.provider || !model?.model) return null;
    let user = '';
    for (let j = i - 1; j >= 0; j--) {
      if (nodes[j].kind === 'user' || nodes[j].kind === 'steering') {
        user = nodes[j].content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        break;
      }
    }
    return { sessionId, replyId: String(node.messageId ?? node.seq), provider: model.provider, model: model.model,
      ...recommendationContext({ assistant, user }) };
  }
  return null;
}

export function canAccept(state) {
  return Boolean(state?.suggestion && !state.running && !state.removed && state.editable
    && state.input?.phase === 'plain' && state.input.draft === ''
    && state.input.attachmentIds.length === 0 && state.input.occurrences.length === 0
    && state.input.queue.length === 0);
}

export function installAcceptance(editor, read, accept, dismiss, now = () => Date.now()) {
  let composing = false;
  let imeUntil = 0;
  let acceptedUntilKeyUp = false;
  const swallow = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = event => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    if (event.isComposing || composing || event.keyCode === 229 || now() < imeUntil) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter' && acceptedUntilKeyUp && event.repeat) { swallow(event); return; }
    if (!canAccept(read())) return;
    if (event.key === 'Escape') { swallow(event); dismiss(); return; }
    if (event.repeat) return;
    // Consume before changing the draft: the native submit handler must never see this Enter.
    swallow(event);
    acceptedUntilKeyUp = true;
    accept();
  };
  const up = event => { if (event.key === 'Enter') acceptedUntilKeyUp = false; };
  const start = () => { composing = true; };
  const end = () => { composing = false; imeUntil = now() + 50; };
  editor.addEventListener('keydown', down, true);
  editor.addEventListener('keyup', up, true);
  editor.addEventListener('compositionstart', start, true);
  editor.addEventListener('compositionend', end, true);
  return () => {
    editor.removeEventListener('keydown', down, true);
    editor.removeEventListener('keyup', up, true);
    editor.removeEventListener('compositionstart', start, true);
    editor.removeEventListener('compositionend', end, true);
  };
}
