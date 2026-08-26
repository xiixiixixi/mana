const { Agent, ProxyAgent, setGlobalDispatcher } = require('undici');
const { execFileSync } = require('child_process');

const NETWORKSETUP = '/usr/sbin/networksetup';
const RECHECK_MS = 5_000;

function createProxyManager({
  env = process.env,
  execFileImpl = execFileSync,
  setDispatcher = setGlobalDispatcher,
  proxyFactory = url => new ProxyAgent(url),
  directFactory = () => new Agent(),
  nowImpl = Date.now,
  recheckMs = RECHECK_MS,
  logger = console,
} = {}) {
  let initialized = false;
  let currentKey = '';
  let currentState = { source: 'direct', url: null };
  let currentDispatcher = null;
  let lastCheckedAt = 0;

  function detectProxy() {
    const envProxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
    if (envProxy) return { source: 'env', url: envProxy };

    let services = [];
    try {
      services = String(execFileImpl(NETWORKSETUP, ['-listallnetworkservices'], { encoding: 'utf8' }) || '')
        .split('\n')
        .slice(1)
        .map(s => s.replace(/^\*/, '').trim())
        .filter(Boolean);
    } catch {
      return { source: 'direct', url: null };
    }

    for (const service of services) {
      for (const command of ['-getsecurewebproxy', '-getwebproxy']) {
        let output = '';
        try {
          output = String(execFileImpl(NETWORKSETUP, [command, service], { encoding: 'utf8' }) || '');
        } catch {
          continue;
        }
        const enabled = /Enabled:\s*Yes/i.test(output);
        const host = (output.match(/Server:\s*(\S+)/i) || [])[1];
        const port = (output.match(/Port:\s*(\d+)/i) || [])[1];
        if (enabled && host && port) return { source: 'system', url: `http://${host}:${port}` };
      }
    }
    return { source: 'direct', url: null };
  }

  function describe(state) {
    if (!state.url) return 'direct connection';
    try {
      const u = new URL(state.url);
      return `${state.source} proxy ${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    } catch {
      return `${state.source} proxy`;
    }
  }

  function replaceDispatcher(next) {
    const nextKey = `${next.source}:${next.url || ''}`;
    if (initialized && nextKey === currentKey) return;

    const previous = currentDispatcher;
    currentDispatcher = next.url ? proxyFactory(next.url) : directFactory();
    setDispatcher(currentDispatcher);
    currentKey = nextKey;
    initialized = true;
    logger.log(`Using ${describe(next)}`);

    if (previous && previous !== currentDispatcher && typeof previous.close === 'function') {
      Promise.resolve(previous.close()).catch(() => {});
    }
  }

  function refresh({ force = false } = {}) {
    const now = nowImpl();
    if (!force && initialized && now - lastCheckedAt < recheckMs) return { ...currentState };
    lastCheckedAt = now;
    const next = detectProxy();
    replaceDispatcher(next);
    currentState = next;
    return { ...currentState };
  }

  return {
    setup: () => refresh({ force: true }),
    refresh,
    getState: () => ({ ...currentState }),
  };
}

const defaultManager = createProxyManager();

// Node.js fetch（undici）不会自动跟随 macOS 系统代理。启动时配置一次，之后各联网
// 服务在请求前调用 refreshProxy()，从而在用户切换代理后自动更新，不必重启 Mana。
function setupProxy() {
  return defaultManager.setup();
}

function refreshProxy(options) {
  return defaultManager.refresh(options);
}

module.exports = { createProxyManager, setupProxy, refreshProxy };
