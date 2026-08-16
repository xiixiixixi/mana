const { BaseProvider } = require('./base');
const { httpGetJson, formatResetAt } = require('./common');

// 端点来源: opencode-bar KimiProvider.swift, GCMP kimiStatusBar.ts
// 端点: GET https://api.kimi.com/coding/v1/usages
// 认证: Authorization: Bearer $API_KEY

class KimiProvider extends BaseProvider {
  constructor() {
    super({
      id: 'kimi', name: 'Kimi', icon: 'K',
      color: '#06b6d4', colorDim: 'rgba(6,182,212,0.12)',
      consoleUrl: 'https://platform.kimi.com',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://api.kimi.com/coding/v1/usages', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }).catch(e => {
      // Kimi 国内站与国际站 Key 完全隔离，互用会 401
      if (e.status === 401) throw new Error('Key 无效（Kimi 国内/国际 Key 不通用，请确认 Key 所属区域）');
      throw e;
    });

    const quotas = [];
    const membership = json.user?.membership?.level || '';
    const planLabel = membership.replace('LEVEL_', '').charAt(0).toUpperCase() + membership.replace('LEVEL_', '').slice(1).toLowerCase();

    // 5h / short windows
    if (json.limits) {
      for (const lim of json.limits) {
        const detail = lim.detail;
        if (detail) {
          quotas.push({
            label: lim.window ? `${lim.window.duration}${lim.window.timeUnit?.replace('TIME_UNIT_', '').toLowerCase() || 'h'}窗口` : '额度',
            used: parseInt(detail.used) || 0,
            total: parseInt(detail.limit) || 0,
            unit: '次',
            resetIn: detail.resetTime ? formatResetAt(detail.resetTime) : null,
            window: lim.window ? `${lim.window.duration}h` : null,
          });
        }
      }
    }

    // Weekly total
    if (json.usage) {
      quotas.push({
        label: '每周总额度',
        used: parseInt(json.usage.used) || 0,
        total: parseInt(json.usage.limit) || 0,
        unit: '次',
        resetIn: json.usage.resetTime ? formatResetAt(json.usage.resetTime) : null,
        window: '7d',
      });
    }

    return this.buildUsage({
      status: 'active',
      plan: `Kimi ${planLabel}`,
      quotas,
    });
  }
}

module.exports = { KimiProvider };
