const { BaseProvider } = require('./base');
const { httpGetJson, formatDuration } = require('./common');

// 端点来源: MiniMax 官方 FAQ https://platform.minimax.io/docs/token-plan/faq
// 端点: GET https://api.minimaxi.com/v1/token_plan/remains (CN)
// 认证: Authorization: Bearer $SUBSCRIPTION_KEY + Content-Type: application/json
// Token Plan 已从次数制改为信用制，remaining_percent 表示剩余百分比

class MinimaxProvider extends BaseProvider {
  constructor() {
    super({
      id: 'minimax', name: 'MiniMax', icon: 'M',
      color: '#a855f7', colorDim: 'rgba(168,85,247,0.12)',
      consoleUrl: 'https://platform.minimaxi.com/console',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://api.minimaxi.com/v1/token_plan/remains', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (json.base_resp?.status_code !== 0) throw new Error(json.base_resp?.status_msg || '查询失败');

    const remains = json.model_remains || [];
    const quotas = [];

    for (const r of remains) {
      const label = r.model_name === 'general' ? 'LLM' : r.model_name || 'default';

      // 信用制：用百分比显示
      if (r.current_interval_remaining_percent !== undefined) {
        const pct = r.current_interval_remaining_percent;
        quotas.push({
          label: `5小时窗口 (${label})`,
          used: 100 - pct,
          total: 100,
          unit: '%',
          resetIn: r.remains_time ? formatDuration(r.remains_time) : null,
          window: '5h',
        });
      }
      if (r.current_weekly_remaining_percent !== undefined) {
        const pct = r.current_weekly_remaining_percent;
        quotas.push({
          label: `每周额度 (${label})`,
          used: 100 - pct,
          total: 100,
          unit: '%',
          resetIn: r.weekly_remains_time ? formatDuration(r.weekly_remains_time) : null,
          window: '7d',
        });
      }
    }

    return this.buildUsage({
      status: 'active',
      plan: 'Token Plan',
      quotas,
    });
  }
}

module.exports = { MinimaxProvider };
