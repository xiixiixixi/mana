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

    for (const tl of tokensLimits) {
      quotas.push({
        label: tl.nextResetTime ? (tl.unit === 60 && tl.number === 5 ? '5小时额度' : '每周额度') : 'Token额度',
        used: tl.percentage || 0,
        total: 100,
        unit: '%',
        resetIn: tl.nextResetTime ? formatResetAt(tl.nextResetTime) : null,
        window: tl.unit === 60 && tl.number === 5 ? '5h' : '7d',
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
