const { BaseProvider } = require('./base');
const { httpGetJson, buildBalanceQuota } = require('./common');

// 端点来源: GCMP siliconflowBalanceQuery.ts
// 端点: GET https://api.siliconflow.cn/v1/user/info
// 认证: Authorization: Bearer $API_KEY

class SiliconFlowProvider extends BaseProvider {
  constructor() {
    super({
      id: 'siliconflow', name: '硅基流动', icon: 'SF',
      color: '#ec4899', colorDim: 'rgba(236,72,153,0.12)',
      consoleUrl: 'https://cloud.siliconflow.cn/account/balance',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://api.siliconflow.cn/v1/user/info', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const d = json.data || {};
    const quotas = [buildBalanceQuota('账户余额', parseFloat(d.totalBalance || d.balance || 0), '¥')];

    return this.buildUsage({
      status: d.status === 'active' ? 'active' : 'inactive',
      plan: '按量计费',
      quotas,
    });
  }
}

module.exports = { SiliconFlowProvider };
