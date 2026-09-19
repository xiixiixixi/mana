const { BaseProvider } = require('./base');
const { httpGetJson, formatResetAt } = require('./common');

// 端点来源: GCMP zhipuStatusBar.ts, opencode-bar ZaiCodingPlanProvider.swift, cc-switch #1588
// 认证: Authorization: $KEY (无 Bearer 前缀)

// unit 枚举实测（2026-09 直连 open.bigmodel.cn 确认）：3=小时(5h 窗口)、6=周、5=月。
// unit 优先于剩余时长分桶——纯时长无法区分"周窗口中段"与"每日额度"
// （每周额度重置 2 天后剩余 <5 天，旧逻辑会错标成"每日额度"；剩 9~25 天的月度同理）。
const UNIT_WINDOWS = { 3: '5h 窗口', 6: '每周额度', 5: '每月额度' };

function windowLabel(tl) {
  if (!tl.nextResetTime) return 'Token额度';
  if (UNIT_WINDOWS[tl.unit]) return UNIT_WINDOWS[tl.unit];
  // 兜底（unit 缺失/未知）：5h 窗口剩余必 ≤8h、每日额度必 ≤24h；24h~25d 之间按周窗口中段处理
  const ms = new Date(tl.nextResetTime).getTime() - Date.now();
  const h = ms / 3600000;
  if (h <= 8) return '5h 窗口';
  if (h <= 24) return '每日额度';
  if (h >= 25 * 24) return '每月额度';
  return '每周额度';
}

const WINDOW_TAGS = { '5h 窗口': '5h', '每日额度': '1d', '每周额度': '7d', '每月额度': '30d' };

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
      const label = windowLabel(tl);
      quotas.push({
        label,
        used: tl.percentage || 0,
        total: 100,
        unit: '%',
        resetIn: tl.nextResetTime ? formatResetAt(tl.nextResetTime) : null,
        window: WINDOW_TAGS[label] ?? null,
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

module.exports = { ZhipuProvider, windowLabel };
