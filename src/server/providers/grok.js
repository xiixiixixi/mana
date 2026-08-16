const { BaseProvider } = require('./base');
const { httpGetJson } = require('./common');

// 端点: GET https://management-api.x.ai/v1/billing/teams/{team_id}/credit-balance
// 认证: Bearer Management API Key
// Key 格式: "api_key:team_id" 或单独 api_key (自动发现 team)

class GrokProvider extends BaseProvider {
  constructor() {
    super({
      id: 'grok', name: 'Grok', icon: 'G',
      color: '#1d1d1f', colorDim: 'rgba(29,29,31,0.12)',
      consoleUrl: 'https://console.x.ai',
      apiType: 'apiKey', region: 'global', cacheTTL: 60,
    });
  }

  async fetchUsage(apiKey) {
    // Parse "key:team_id" format
    const parts = apiKey.split(':');
    const key = parts[0];
    const teamId = parts[1];

    if (!teamId) {
      // Try to discover team ID
      const team = await this.discoverTeam(key);
      if (!team) throw new Error('需要 team_id。请将 Key 格式设为 "api_key:team_id"');
      return this.fetchBalance(key, team);
    }

    return this.fetchBalance(key, teamId);
  }

  async fetchBalance(key, teamId) {
    const json = await httpGetJson(`https://management-api.x.ai/v1/billing/teams/${teamId}/credit-balance`, {
      headers: { 'Authorization': `Bearer ${key}` },
    }).catch(e => {
      if (e.status === 401) throw new Error('API Key 无效');
      if (e.status === 403) throw new Error('无权限访问该 team');
      throw e;
    });

    const quotas = [];
    if (json.credits_remaining !== undefined) {
      quotas.push({
        label: 'Credits 余额',
        used: 0, total: 0, unit: '$',
        balance: parseFloat(json.credits_remaining) || 0,
        resetIn: null, window: null,
      });
    }

    // If no specific fields, show raw balance
    if (quotas.length === 0 && json.balance !== undefined) {
      quotas.push({
        label: '余额',
        used: 0, total: 0, unit: '$',
        balance: parseFloat(json.balance) || 0,
        resetIn: null, window: null,
      });
    }

    return this.buildUsage({
      status: 'active',
      plan: 'xAI API',
      quotas,
    });
  }

  async discoverTeam(key) {
    try {
      const json = await httpGetJson('https://management-api.x.ai/v1/teams', {
        headers: { 'Authorization': `Bearer ${key}` },
        timeout: 5000,
      });
      // Try to find team ID from response
      const teams = json.teams || json.data || json;
      if (Array.isArray(teams) && teams.length > 0) {
        return teams[0].id || teams[0].team_id || teams[0];
      }
      if (json.id) return json.id;
      if (json.team_id) return json.team_id;
      return null;
    } catch {
      return null;
    }
  }

  validateKey(key) {
    return typeof key === 'string' && key.trim().length > 0;
  }
}

module.exports = { GrokProvider };
