const { BaseProvider } = require('./base');
const { httpGetJson, buildBalanceQuota } = require('./common');

// 端点来源: GCMP deepseekStatusBar.ts
// 端点: GET https://api.deepseek.com/v1/user/balance
// 认证: Authorization: Bearer $API_KEY

class DeepseekProvider extends BaseProvider {
  constructor() {
    super({
      id: 'deepseek', name: 'DeepSeek', icon: 'DS',
      color: '#2563eb', colorDim: 'rgba(37,99,235,0.12)',
      consoleUrl: 'https://platform.deepseek.com/usage',
      apiType: 'apiKey', region: 'cn', cacheTTL: 30,
    });
  }

  async fetchUsage(apiKey) {
    const json = await httpGetJson('https://api.deepseek.com/v1/user/balance', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const quotas = [];
    const infos = json.balance_infos || [];
    for (const info of infos) {
      const currency = info.currency || '¥';
      quotas.push(buildBalanceQuota(`余额 (${currency === '¥' ? 'CNY' : currency})`, parseFloat(info.total_balance || 0), currency));
    }

    return this.buildUsage({
      status: json.is_available ? 'active' : 'inactive',
      plan: '按量计费',
      quotas,
    });
  }
}

module.exports = { DeepseekProvider };
