class BaseProvider {
  constructor(config = {}, deps = {}) {
    this.id = config.id;
    this.name = config.name;
    this.icon = config.icon;
    this.color = config.color;
    this.colorDim = config.colorDim;
    this.consoleUrl = config.consoleUrl || null;
    this.plan = config.plan || null;
    this.apiType = config.apiType || 'apiKey';
    this.region = config.region || 'cn';
    this.cacheTTL = config.cacheTTL || 30;
    this.deps = deps;
  }

  async fetchUsage(apiKey) {
    throw new Error(`fetchUsage not implemented for ${this.id}`);
  }

  validateKey(key) {
    return typeof key === 'string' && key.trim().length > 0;
  }

  getMetadata() {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      color: this.color,
      colorDim: this.colorDim,
      consoleUrl: this.consoleUrl,
      apiType: this.apiType,
      region: this.region,
      plan: this.plan,
    };
  }

  buildUsage({ status, plan, quotas }) {
    return {
      id: this.id, name: this.name, icon: this.icon,
      color: this.color, colorDim: this.colorDim,
      consoleUrl: this.consoleUrl,
      status, plan,
      apiType: this.apiType, region: this.region,
      quotas, fetchedAt: Date.now(),
    };
  }
}

module.exports = { BaseProvider };
