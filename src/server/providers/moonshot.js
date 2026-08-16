const { BaseProvider } = require('./base');
const { httpGetJson, buildBalanceQuota } = require('./common');

// 端点来源: Kimi官方文档 platform.kimi.com/docs/api/balance, GCMP moonshotStatusBar.ts
// 端点: GET https://api.moonshot.cn/v1/users/me/balance
// 认证: Authorization: Bearer $API_KEY

class MoonshotProvider extends BaseProvider {
  constructor() {
    super({
      id: 'moonshot', name: 'Moonshot', icon: '☽',
      color: '#8b5cf6', colorDim: 'rgba(139,92,246,0.12)',
      consoleUrl: 'https://platform.moonshot.cn/console/account',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    // 国内站 api.moonshot.cn 与国际站 api.moonshot.ai Key 隔离：401 时换站重试
    let json = null, lastErr = null;
    for (const host of ['api.moonshot.cn', 'api.moonshot.ai']) {
      try {
        json = await httpGetJson(`https://${host}/v1/users/me/balance`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        break;
      } catch (e) {
        lastErr = e;
        if (e.status !== 401) throw e;
      }
    }
    if (!json) {
      throw new Error('Key 无效（Moonshot 国内/国际 Key 不通用，两站均拒绝）');
    }
    if (!json.status) throw new Error(json.msg || '查询失败');

    const d = json.data || {};
    const quotas = [];

    if (d.available_balance !== undefined) {
      quotas.push(buildBalanceQuota('可用余额', d.available_balance, '¥'));
    }
    if (d.voucher_balance !== undefined) {
      quotas.push(buildBalanceQuota('代金券', d.voucher_balance, '¥'));
    }
    if (d.cash_balance !== undefined) {
      quotas.push(buildBalanceQuota('现金余额', d.cash_balance, '¥'));
    }

    return this.buildUsage({
      status: 'active',
      plan: '按量计费',
      quotas,
    });
  }
}

module.exports = { MoonshotProvider };
