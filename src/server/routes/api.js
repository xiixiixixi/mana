const { createUsageOrchestrator } = require('../services/usageOrchestrator');
const { quotaRemaining, minRemainingPct } = require('../services/remaining');

function createApiRouter(providers, keyStore, cache) {
  const router = require('express').Router();
  const orchestrator = createUsageOrchestrator({ providers, keyStore, cache });

  // GET /api/providers — 平台元数据列表
  router.get('/providers', (_req, res) => {
    const list = Array.from(providers.values()).map(p => p.getMetadata());
    res.json({ providers: list });
  });

  // /api/usage 与 /api/summary 共用的取数管线（含多 key 展开）
  async function collectUsage(sid) {
    const keyStatus = keyStore.status(sid);
    const results = [];
    const errors = {};

    const autoTypes = new Set(['oauth', 'local']);
    const configured = [];
    for (const [pid, provider] of providers) {
      // keyStatus[pid] 现在是数组（多 key）
      const hasKey = Array.isArray(keyStatus[pid]) ? keyStatus[pid].length > 0 : keyStatus[pid]?.configured;
      // oauth/local 型平台只在环境里确有凭证/数据源时才纳入——
      // 未授权的 Copilot、未安装的 Codex 不进首页（配置过但失效的仍展示错误，便于发现）
      const autoOk = autoTypes.has(provider.apiType)
        && typeof provider.isConfigured === 'function'
        && provider.isConfigured(sid, keyStore);
      if (hasKey || autoOk) {
        configured.push(pid);
      }
    }

    if (configured.length === 0) {
      return { expanded: [], errors: {} };
    }

    const settled = await Promise.allSettled(configured.map(pid => orchestrator.fetchOne(sid, pid)));

    for (let i = 0; i < configured.length; i++) {
      const r = settled[i];
      const pid = configured[i];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        errors[pid] = r.reason?.message || 'Unknown error';
        const provider = providers.get(pid);
        if (provider) {
          results.push({
            ...provider.getMetadata(),
            status: 'error',
            quotas: [],
            fetchedAt: Date.now(),
            latency: r.reason?.latency,
            error: errors[pid],
          });
        }
      }
    }
    // Expand multi-key providers into per-key entries
    const expanded = [];
    for (const r of results) {
      if (r.status === 'error') { expanded.push(r); continue; }
      const pid = r.id;
      const keys = keyStore.getAllKeysForProvider(sid, pid);
      if (keys.length <= 1) { expanded.push(r); continue; }
      // Per-key expansion
      const provider = providers.get(pid);
      for (const keyEntry of keys) {
        try {
          const keyData = await provider.fetchUsage(keyEntry.apiKey);
          expanded.push({
            ...provider.getMetadata(),
            ...keyData,
            id: pid,
            label: (keyEntry.label && keyEntry.label !== 'None') ? keyEntry.label : (keyEntry.hint || null),
            hint: keyEntry.hint || null,
            keyId: keyEntry.id,
            status: 'active',
            fetchedAt: Date.now(),
          });
        } catch (e) {
          expanded.push({
            ...provider.getMetadata(),
            id: pid,
            label: (keyEntry.label && keyEntry.label !== 'None') ? keyEntry.label : (keyEntry.hint || null),
            hint: keyEntry.hint || null,
            keyId: keyEntry.id,
            status: 'error',
            error: e.message || 'Unknown error',
            quotas: [],
            fetchedAt: Date.now(),
          });
        }
      }
    }

    return { expanded, errors };
  }

  // GET /api/usage — 所有已配置平台的用量
  router.get('/usage', async (req, res) => {
    const { expanded, errors } = await collectUsage(req.sessionId);
    res.json({ providers: expanded, errors });
  });

  // GET /api/summary — 单对象摘要（statusline/CLI 场景：一次请求一个数字）
  router.get('/summary', async (req, res) => {
    const { expanded } = await collectUsage(req.sessionId);
    let lowest = null, lowestProvider = null;
    for (const p of expanded) {
      if (p.status === 'error') continue;
      const m = minRemainingPct(p.quotas);
      if (m !== null && (lowest === null || m < lowest)) { lowest = m; lowestProvider = p.label ? `${p.name}·${p.label}` : p.name; }
    }
    res.json({
      schemaVersion: 1,
      lowestRemainingPct: lowest,
      lowestProvider,
      providerCount: expanded.filter(p => p.status !== 'error').length,
      updatedAt: Date.now(),
    });
  });

  // GET /api/usage/:id — 单平台用量
  router.get('/usage/:id', async (req, res) => {
    const { id } = req.params;
    const provider = providers.get(id);
    if (!provider) return res.status(404).json({ error: `Provider ${id} not found` });

    if (provider.apiType === 'apiKey') {
      const keys = keyStore.getAllKeysForProvider(req.sessionId, id);
      if (keys.length === 0) return res.status(400).json({ error: `No API key configured for ${id}` });
    }

    try {
      const data = await orchestrator.fetchOne(req.sessionId, id);
      res.json(data);
    } catch (err) {
      if (err.status !== 429) {
        res.status(502).json({ error: err.message });
      } else {
        // 429 with no lastGood is a fresh rate limit; surface as 502 so client retries
        res.status(502).json({ error: err.message });
      }
    }
  });

  return router;
}

module.exports = { createApiRouter };