const { BaseProvider } = require('./base');
const { httpGetJson, formatResetAt } = require('./common');

// 端点来源: GCMP zhipuStatusBar.ts, opencode-bar ZaiCodingPlanProvider.swift, cc-switch #1588
// 认证: Authorization: $KEY (无 Bearer 前缀)

class ZhipuProvider extends BaseProvider {
  constructor() {
    super({
      id: 'zhipu', name: '智谱 GLM', icon: 'Z',
      color: '#3b82f6', colorDim: 'rgba(59,130,246,0.12)',
      consoleUrl: 'https://open.bigmodel.cn/console',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      headers: { 'Authorization': apiKey },
    });
    if (!json.success) throw new Error(json.msg || '查询失败');

    const limits = json.data?.limits || [];
    const quotas = [];
    const tokensLimits = limits.filter(l => l.type === 'TOKENS_LIMIT');
    const timeLimits = limits.filter(l => l.type === 'TIME_LIMIT');

    // 按重置剩余时长判别窗口类型：unit 是平台枚举（实测 3=小时、6=周、5=月），
    // 但不同套餐组合不一，直接用 nextResetTime 距今的时长分桶最稳。
    function windowLabel(tl) {
      if (!tl.nextResetTime) return 'Token额度';
      const ms = new Date(tl.nextResetTime).getTime() - Date.now();
      const h = ms / 3600000;
      if (h <= 8) return '5h 窗口';
      if (h >= 5 * 24 && h <= 9 * 24) return '每周额度';
      if (h >= 25 * 24) return '每月额度';
      return '每日额度';
    }

    for (const tl of tokensLimits) {
      const label = windowLabel(tl);
      quotas.push({
        label,
        used: tl.percentage || 0,
        total: 100,
        unit: '%',
        resetIn: tl.nextResetTime ? formatResetAt(tl.nextResetTime) : null,
        window: label === '5h 窗口' ? '5h' : label === '每周额度' ? '7d' : '30d',
      });
    }
    for (const tl of timeLimits) {
      quotas.push({
        label: 'MCP月度',
        used: tl.currentValue || 0,
        total: tl.usage || 1000,
        unit: '次',
        resetIn: tl.nextResetTime ? formatResetAt(tl.nextResetTime) : null,
        window: '30d',
      });
    }

    return this.buildUsage({
      status: 'active',
      plan: `Coding Plan · ${json.data?.level || 'unknown'}`,
      quotas,
    });
  }
}

module.exports = { ZhipuProvider };
