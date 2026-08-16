const { BaseProvider } = require('./base');
const { httpGetJson, buildBalanceQuota } = require('./common');

// 端点来源: opencode-bar OpenRouterProvider.swift, GCMP openrouterBalanceQuery.ts
// 端点: GET https://openrouter.ai/api/v1/credits
// 认证: Authorization: Bearer $API_KEY

class OpenRouterProvider extends BaseProvider {
  constructor() {
    super({
      id: 'openrouter', name: 'OpenRouter', icon: 'OR',
      color: '#6366f1', colorDim: 'rgba(99,102,241,0.12)',
      consoleUrl: 'https://openrouter.ai/credits',
      apiType: 'apiKey', region: 'global', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://openrouter.ai/api/v1/credits', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const d = json.data || {};
    const totalCredits = parseFloat(d.total_credits || 0);
    const totalUsage = parseFloat(d.total_usage || 0);
    const remaining = totalCredits - totalUsage;

    const quotas = [buildBalanceQuota('Credits 余额', Math.round(remaining * 100) / 100, '$')];

    return this.buildUsage({
      status: remaining > 0 ? 'active' : 'warning',
      plan: 'Pay-as-you-go',
      quotas,
    });
  }
}

module.exports = { OpenRouterProvider };
