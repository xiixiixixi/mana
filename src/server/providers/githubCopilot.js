const { BaseProvider } = require('./base');
const { httpGetJson, formatResetAt } = require('./common');

// 端点: GET https://api.github.com/copilot_internal/user
// 认证: Bearer GitHub OAuth token（通过 OAuth 流程获取，存储在 keyStore）
// 返回: quota_snapshots 中的 premium_interactions / chat / completions 余量

class GithubCopilotProvider extends BaseProvider {
  constructor() {
    super({
      id: 'github-copilot', name: 'GitHub Copilot', icon: 'GC',
      color: '#1f2937', colorDim: 'rgba(31,41,55,0.12)',
      consoleUrl: 'https://github.com/settings/copilot',
      apiType: 'oauth', region: 'global', cacheTTL: 300,
    });
  }

  async fetchUsage(token) {
    if (!token) throw new Error('未连接 GitHub。请在设置中点击「授权」按钮进行 OAuth 登录。');

    const json = await httpGetJson('https://api.github.com/copilot_internal/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Editor-Version': 'vscode/1.99.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
      },
    }).catch(e => {
      if (e.status === 401) throw new Error('GitHub token 已过期，请重新授权');
      throw e;
    });

    const plan = json.copilot_plan || 'Unknown';
    const snapshots = json.quota_snapshots || {};
    const resetDate = json.quota_reset_date || null;

    const quotas = [];

    // quota_snapshots 字段语义（实测 Business 套餐 2026-08）：
    //   entitlement/credits_used/remaining = Premium 积分额度（token_based_billing 下 has_quota:false 仍有效）
    //   unlimited:true = 无限额度（Chat/补全 在 Business 下为无限）
    if (snapshots.premium_interactions) {
      const pi = snapshots.premium_interactions;
      if (pi.unlimited) {
        quotas.push({ label: 'Premium 交互', used: 0, total: 0, unit: '次', unlimited: true, resetIn: null, window: null });
      } else if (pi.entitlement > 0) {
        const used = typeof pi.credits_used === 'number'
          ? pi.credits_used
          : Math.max(0, pi.entitlement - (pi.remaining || 0));
        quotas.push({
          label: 'Premium 交互',
          used,
          total: pi.entitlement,
          unit: pi.token_based_billing ? '积分' : '次',
          resetIn: pi.quota_reset_at > 0 ? formatResetAt(pi.quota_reset_at * 1000) : resetDate,
          window: 'monthly',
        });
      }
    }

    for (const [key, label] of [['chat', 'Chat'], ['completions', '补全']]) {
      const q = snapshots[key];
      if (!q) continue;
      if (q.unlimited) {
        quotas.push({ label, used: 0, total: 0, unit: '次', unlimited: true, resetIn: null, window: null });
      } else if (q.has_quota !== false && typeof q.percent_remaining === 'number') {
        quotas.push({
          label,
          used: 100 - q.percent_remaining, total: 100, unit: '%',
          resetIn: q.quota_reset_at > 0 ? formatResetAt(q.quota_reset_at * 1000) : resetDate,
          window: 'monthly',
        });
      }
    }

    return this.buildUsage({
      status: 'active',
      plan: `Copilot ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      quotas,
    });
  }

  validateKey(key) {
    return typeof key === 'string' && key.trim().length > 0;
  }
}

module.exports = { GithubCopilotProvider };
