import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { join } from 'node:path';
import { PACKAGE, SERVICE, descriptor, usageDescriptor, updatePricesDescriptor, setPriceScheduleDescriptor } from './common.mjs';
import { createRecommender } from './engine.mjs';
import { createUsageStore } from './usage.mjs';
import { createPriceStore } from './price-updates.mjs';

export const name = PACKAGE;
export const inject = ['llm', 'typert'];

class ReplySuggestions extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, SERVICE);
    const directory = join(resolveDshHome(), 'storages', PACKAGE);
    this.prices = createPriceStore(join(directory, 'prices.jsonl'), {
      autoUpdate: config.autoUpdatePrices !== false, intervalMs: (config.priceUpdateDays ?? 7) * 86400000,
    });
    this.usageStore = createUsageStore(join(directory, 'usage.jsonl'), {
      prices: this.prices,
      retention: { withFileLock, writeFileAtomic },
      warn: error => console.warn('[reply-suggestions] Usage persistence unavailable:', error?.code ?? 'unknown'),
    });
    this.generate = createRecommender(ctx.llm, config, this.usageStore);
    ctx.effect(() => {
      const check = this.checkPrices = () => {
        this.prices.refresh().catch(() => {});
        this.usageStore.maintain().catch(() => {});
      };
      check(); // The store restores UI preferences before deciding whether to check.
      const timer = setInterval(check, 3600000);
      timer?.unref?.();
      return () => { if (timer) clearInterval(timer); this.prices.dispose(); };
    });
  }
  async recommend(input, signal) { return this.generate(input, signal); }
  async usage() { return this.usageStore.snapshot(); }
  async updatePrices() { await this.prices.refresh({ force: true }); return this.usageStore.snapshot(); }
  async setPriceSchedule(schedule) {
    await this.prices.setSchedule(schedule);
    this.checkPrices();
    return this.usageStore.snapshot();
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (config.autoUpdatePrices !== undefined && typeof config.autoUpdatePrices !== 'boolean') throw new TypeError('autoUpdatePrices must be a boolean');
  if (config.priceUpdateDays !== undefined && (!Number.isInteger(config.priceUpdateDays) || config.priceUpdateDays < 1 || config.priceUpdateDays > 30)) {
    throw new TypeError('priceUpdateDays must be an integer between 1 and 30');
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000)) {
    throw new TypeError('timeoutMs must be an integer between 1000 and 60000');
  }
  for (const field of ['provider', 'model']) {
    if (config[field] !== undefined && (typeof config[field] !== 'string' || !config[field].trim())) throw new TypeError(`${field} must be a nonempty string`);
  }
  ctx.plugin(ReplySuggestions, { ...config });
  ctx.typert.register({ package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: [descriptor(), usageDescriptor(), updatePricesDescriptor(), setPriceScheduleDescriptor()] });
}
