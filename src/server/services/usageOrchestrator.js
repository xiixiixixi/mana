// 协调单 provider 用量获取：缓存 → 429 冷却 → fetch → 错误带 latency。
// 支持多 key：遍历所有 key 分别拉取，聚合 quotas。

const COOLDOWN_MS = 90 * 1000;

function createUsageOrchestrator({ providers, keyStore, cache }) {
  const cooldown = new Map();
  const lastGood = new Map();

  async function fetchOne(sid, providerId) {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const cached = cache.get(providerId);
    if (cached) return cached;

    const until = cooldown.get(providerId);
    if (until && until > Date.now()) {
      const good = lastGood.get(providerId);
      if (good) return { ...good, status: 'rate_limited', stale: true };
      return { ...provider.getMetadata(), status: 'rate_limited', quotas: [], fetchedAt: Date.now() };
    }

    const keys = keyStore.getAllKeysForProvider(sid, providerId);
    const isOAuth = provider.apiType === 'oauth' || provider.apiType === 'local';

    // 无 key 的 provider（OAuth/local 自动检测）
    if (keys.length === 0 && !isOAuth) {
      throw new Error(`No key for ${providerId}`);
    }

    // 多 key 逐个拉取
    const keyList = keys.length > 0 ? keys : [null];
    const perKeyResults = [];
    const t0 = performance.now();

    for (const keyEntry of keyList) {
      const apiKey = keyEntry?.apiKey || null;
      try {
        const data = await provider.fetchUsage(apiKey);
        perKeyResults.push({
          keyId: keyEntry?.id || null,
          keyLabel: keyEntry?.label || null,
          ok: true,
          data,
        });
      } catch (e) {
        e.latency = Math.round(performance.now() - t0);
        if (e.status === 429) cooldown.set(providerId, Date.now() + COOLDOWN_MS);
        perKeyResults.push({
          keyId: keyEntry?.id || null,
          keyLabel: keyEntry?.label || null,
          ok: false,
          error: e.message || 'Unknown error',
          latency: e.latency,
        });
      }
    }

    // 聚合所有成功的 key 结果
    const successes = perKeyResults.filter(r => r.ok);
    if (successes.length === 0) {
      // 全部失败，抛出第一个错误
      const firstErr = perKeyResults.find(r => !r.ok);
      const e = new Error(firstErr?.error || 'All keys failed');
      e.latency = firstErr?.latency || Math.round(performance.now() - t0);
      throw e;
    }

    // 取第一个成功结果作为基础元数据
    const base = successes[0].data;
    // 如果只有一个 key，直接返回
    if (successes.length === 1) {
      const withLatency = { ...base, latency: Math.round(performance.now() - t0) };
      cache.set(providerId, withLatency, provider.cacheTTL);
      lastGood.set(providerId, withLatency);
      return withLatency;
    }

    // 多 key：聚合 quotas（累加 used/balance）
    const mergedQuotas = [];
    const quotaCount = base.quotas?.length || 0;
    for (let i = 0; i < quotaCount; i++) {
      const baseQ = base.quotas[i] || {};
      let used = baseQ.used != null ? baseQ.used : 0;
      let balance = baseQ.balance != null ? baseQ.balance : 0;
      for (let j = 1; j < successes.length; j++) {
        const q = successes[j].data.quotas?.[i];
        if (q) {
          if (q.used != null) used += q.used;
          if (q.balance != null) balance += q.balance;
        }
      }
      mergedQuotas.push({
        ...baseQ,
        used: baseQ.used != null ? used : undefined,
        balance: baseQ.balance != null ? balance : undefined,
      });
    }

    const merged = {
      ...base,
      quotas: mergedQuotas,
      latency: Math.round(performance.now() - t0),
      keyCount: successes.length,
    };

    cache.set(providerId, merged, provider.cacheTTL);
    lastGood.set(providerId, merged);
    return merged;
  }

  return { fetchOne };
}

module.exports = { createUsageOrchestrator };
