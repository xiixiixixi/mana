const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../src/server/routes/api.js');

function createProvider(id, fetchUsage) {
  const metadata = { id, name: id };

  return {
    getMetadata() {
      return metadata;
    },
    apiType: 'apiKey',
    cacheTTL: 60,
    fetchUsage,
  };
}

function successUsage(provider) {
  return {
    ...provider.getMetadata(),
    status: 'active',
    quotas: [{ name: 'q', used: 1, limit: 10 }],
    fetchedAt: Date.now(),
  };
}

function rateLimitError() {
  return Object.assign(new Error('HTTP 429'), { status: 429 });
}

function createKeyStore(keysByProvider) {
  return {
    save(_sid, pid, key) {
      keysByProvider[pid] = key;
    },
    get(_sid, pid) {
      return keysByProvider[pid] || null;
    },
    remove(_sid, pid) {
      delete keysByProvider[pid];
    },
    getAllKeysForProvider(_sid, pid) {
      const key = keysByProvider[pid];
      return key ? [{id: 'mock', label: null, apiKey: key, createdAt: null}] : [];
    },
    status() {
      return Object.fromEntries(
        Object.entries(keysByProvider).map(([pid, key]) => [pid, { configured: Boolean(key) }]),
      );
    },
  };
}

function createNullCache() {
  return {
    get: mock.fn(() => null),
    set: mock.fn(() => undefined),
    invalidate: mock.fn(() => undefined),
  };
}

function createStaticCache(value) {
  return {
    get: mock.fn(() => value),
    set: mock.fn(() => undefined),
    invalidate: mock.fn(() => undefined),
  };
}

async function startApiServer(providers, keyStore, cache) {
  const app = express();
  app.use((req, _res, next) => {
    req.sessionId = 'test';
    next();
  });
  app.use('/api', createApiRouter(providers, keyStore, cache));

  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, () => resolve(srv));
    srv.once('error', reject);
  });
  const address = server.address();

  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function getJson(baseUrl, path) {
  const response = await fetch(baseUrl + path);
  const body = await response.json();
  return { response, body };
}

test('S1 /api/usage records numeric latency and fetchedAt on success', async () => {
  let provider;
  const fetchUsage = mock.fn(async () => successUsage(provider));
  provider = createProvider('latency', fetchUsage);
  const server = await startApiServer(
    new Map([['latency', provider]]),
    createKeyStore({ latency: 'key' }),
    createNullCache(),
  );

  try {
    const { response, body } = await getJson(server.baseUrl, '/api/usage');

    assert.equal(response.status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].status, 'active');
    assert.equal(typeof body.providers[0].latency, 'number');
    assert.ok(body.providers[0].latency >= 0);
    assert.ok(body.providers[0].fetchedAt);
    assert.equal(fetchUsage.mock.callCount(), 1);
  } finally {
    await server.close();
  }
});

test('S2 /api/usage includes error latency and errors entry for first 429', async () => {
  const fetchUsage = mock.fn(async () => {
    throw rateLimitError();
  });
  const provider = createProvider('limited', fetchUsage);
  const server = await startApiServer(
    new Map([['limited', provider]]),
    createKeyStore({ limited: 'key' }),
    createNullCache(),
  );

  try {
    const { response, body } = await getJson(server.baseUrl, '/api/usage');

    assert.equal(response.status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].status, 'error');
    assert.equal(typeof body.providers[0].latency, 'number');
    assert.ok(body.providers[0].latency >= 0);
    assert.equal(body.errors.limited, 'HTTP 429');
  } finally {
    await server.close();
  }
});

test('S3 /api/usage serves stale last good data inside 429 cooldown', async () => {
  let provider;
  let calls = 0;
  const fetchUsage = mock.fn(async () => {
    calls += 1;
    if (calls === 1) return successUsage(provider);
    throw rateLimitError();
  });
  provider = createProvider('stale', fetchUsage);
  const server = await startApiServer(
    new Map([['stale', provider]]),
    createKeyStore({ stale: 'key' }),
    createNullCache(),
  );

  try {
    const first = await getJson(server.baseUrl, '/api/usage');
    const second = await getJson(server.baseUrl, '/api/usage');
    const third = await getJson(server.baseUrl, '/api/usage');

    assert.equal(first.response.status, 200);
    assert.equal(first.body.providers[0].status, 'active');
    assert.equal(second.response.status, 200);
    assert.equal(second.body.providers[0].status, 'error');
    assert.equal(third.response.status, 200);
    assert.equal(third.body.providers[0].status, 'rate_limited');
    assert.equal(third.body.providers[0].stale, true);
    assert.ok(Array.isArray(third.body.providers[0].quotas));
    assert.ok(third.body.providers[0].quotas.length > 0);
    assert.equal(fetchUsage.mock.callCount(), 2);
  } finally {
    await server.close();
  }
});

test('S4 /api/usage falls back to metadata during cooldown without lastGood', async () => {
  const fetchUsage = mock.fn(async () => {
    throw rateLimitError();
  });
  const provider = createProvider('metadata', fetchUsage);
  const server = await startApiServer(
    new Map([['metadata', provider]]),
    createKeyStore({ metadata: 'key' }),
    createNullCache(),
  );

  try {
    const first = await getJson(server.baseUrl, '/api/usage');
    const second = await getJson(server.baseUrl, '/api/usage');

    assert.equal(first.response.status, 200);
    assert.equal(first.body.providers[0].status, 'error');
    assert.equal(second.response.status, 200);
    assert.equal(second.body.providers[0].status, 'rate_limited');
    assert.deepEqual(second.body.providers[0].quotas, []);
    assert.equal(Object.hasOwn(second.body.providers[0], 'stale'), false);
    assert.equal(fetchUsage.mock.callCount(), 1);
  } finally {
    await server.close();
  }
});

test('S5 /api/usage/:id serves stale last good data inside 429 cooldown', async () => {
  let provider;
  let calls = 0;
  const fetchUsage = mock.fn(async () => {
    calls += 1;
    if (calls === 1) return successUsage(provider);
    throw rateLimitError();
  });
  provider = createProvider('single', fetchUsage);
  const server = await startApiServer(
    new Map([['single', provider]]),
    createKeyStore({ single: 'key' }),
    createNullCache(),
  );

  try {
    const first = await getJson(server.baseUrl, '/api/usage/single');
    const second = await getJson(server.baseUrl, '/api/usage/single');
    const third = await getJson(server.baseUrl, '/api/usage/single');

    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, 'active');
    assert.equal(second.response.status, 502);
    assert.equal(second.body.error, 'HTTP 429');
    assert.equal(third.response.status, 200);
    assert.equal(third.body.status, 'rate_limited');
    assert.equal(third.body.stale, true);
    assert.ok(Array.isArray(third.body.quotas));
    assert.ok(third.body.quotas.length > 0);
    assert.equal(fetchUsage.mock.callCount(), 2);
  } finally {
    await server.close();
  }
});

test('S6 /api/usage returns cached usage without calling fetchUsage', async () => {
  const cachedUsage = {
    id: 'cached',
    name: 'cached',
    status: 'active',
    quotas: [{ name: 'q', used: 1, limit: 10 }],
    fetchedAt: 1234,
    latency: 7,
  };
  const fetchUsage = mock.fn(async () => {
    throw new Error('fetchUsage should not run');
  });
  const provider = createProvider('cached', fetchUsage);
  const server = await startApiServer(
    new Map([['cached', provider]]),
    createKeyStore({ cached: 'key' }),
    createStaticCache(cachedUsage),
  );

  try {
    const { response, body } = await getJson(server.baseUrl, '/api/usage');

    assert.equal(response.status, 200);
    assert.deepEqual(body.providers, [cachedUsage]);
    assert.deepEqual(body.errors, {});
    assert.equal(fetchUsage.mock.callCount(), 0);
  } finally {
    await server.close();
  }
});

test('S7 /api/usage hides oauth/local providers whose environment has no credentials', async () => {
  const makeOauth = (configured) => ({
    getMetadata() { return { id: 'oauthp', name: 'oauthp' }; },
    apiType: 'oauth',
    cacheTTL: 60,
    isConfigured: () => configured,
    fetchUsage: async () => { throw new Error('未连接 GitHub'); },
  });

  // 未配置（无 OAuth token）→ 完全不出现在首页数据里
  {
    const server = await startApiServer(
      new Map([['oauthp', makeOauth(false)]]),
      createKeyStore({}),
      createNullCache(),
    );
    try {
      const { body } = await getJson(server.baseUrl, '/api/usage');
      assert.equal(body.providers.filter(p => p.id === 'oauthp').length, 0);
    } finally {
      await server.close();
    }
  }

  // 已配置但取数失败 → 仍出现（错误卡，便于发现过期凭证）
  {
    const server = await startApiServer(
      new Map([['oauthp', makeOauth(true)]]),
      createKeyStore({}),
      createNullCache(),
    );
    try {
      const { body } = await getJson(server.baseUrl, '/api/usage');
      const entry = body.providers.find(p => p.id === 'oauthp');
      assert.ok(entry);
      assert.equal(entry.status, 'error');
    } finally {
      await server.close();
    }
  }
});
