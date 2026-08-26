const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProxyManager } = require('../src/server/proxy');

function fakeDispatcher(kind, url = null) {
  return { kind, url, close: async () => {} };
}

test('proxy manager follows a system proxy being enabled and disabled', () => {
  let secureProxyEnabled = true;
  const selected = [];
  const manager = createProxyManager({
    env: {},
    execFileImpl: (_bin, args) => {
      if (args[0] === '-listallnetworkservices') return 'An asterisk denotes disabled services.\nWi-Fi\n';
      if (args[0] === '-getsecurewebproxy') {
        return secureProxyEnabled
          ? 'Enabled: Yes\nServer: 127.0.0.1\nPort: 7890\n'
          : 'Enabled: No\nServer: 127.0.0.1\nPort: 7890\n';
      }
      return 'Enabled: No\n';
    },
    setDispatcher: d => selected.push(d),
    proxyFactory: url => fakeDispatcher('proxy', url),
    directFactory: () => fakeDispatcher('direct'),
    logger: { log() {} },
  });

  assert.deepEqual(manager.setup(), { source: 'system', url: 'http://127.0.0.1:7890' });
  assert.equal(selected.at(-1).kind, 'proxy');

  secureProxyEnabled = false;
  assert.deepEqual(manager.refresh({ force: true }), { source: 'direct', url: null });
  assert.equal(selected.at(-1).kind, 'direct');
});

test('environment proxy wins without being overwritten by system detection', () => {
  const env = { HTTPS_PROXY: 'http://proxy.example:8080' };
  let systemCalls = 0;
  const manager = createProxyManager({
    env,
    execFileImpl: () => { systemCalls++; return ''; },
    setDispatcher() {},
    proxyFactory: url => fakeDispatcher('proxy', url),
    directFactory: () => fakeDispatcher('direct'),
    logger: { log() {} },
  });

  assert.deepEqual(manager.setup(), { source: 'env', url: 'http://proxy.example:8080' });
  assert.equal(systemCalls, 0);
  assert.deepEqual(env, { HTTPS_PROXY: 'http://proxy.example:8080' });
});

test('one unavailable network service does not hide a valid proxy on another service', () => {
  const manager = createProxyManager({
    env: {},
    execFileImpl: (_bin, args) => {
      if (args[0] === '-listallnetworkservices') return 'Header\nBroken USB\nWi-Fi\n';
      if (args[1] === 'Broken USB') throw new Error('service unavailable');
      if (args[0] === '-getsecurewebproxy' && args[1] === 'Wi-Fi') {
        return 'Enabled: Yes\nServer: 127.0.0.1\nPort: 7890\n';
      }
      return 'Enabled: No\n';
    },
    setDispatcher() {},
    proxyFactory: url => fakeDispatcher('proxy', url),
    directFactory: () => fakeDispatcher('direct'),
    logger: { log() {} },
  });

  assert.deepEqual(manager.setup(), { source: 'system', url: 'http://127.0.0.1:7890' });
});
