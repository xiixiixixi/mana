const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  fetchCodexOAuthUsage,
  fetchCodexAppServerUsage,
  normalizeAppServerUsage,
  describeLiveError,
} = require('../src/server/providers/codex');

test('Codex live usage refreshes proxy state before going online', async () => {
  const calls = [];
  const usage = await fetchCodexOAuthUsage({
    readTokensImpl: async () => ({ access_token: 'token', account_id: 'acct' }),
    refreshProxyImpl: () => calls.push('proxy'),
    fetchImpl: async (_url, options) => {
      calls.push('fetch');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'acct');
      return {
        ok: true,
        status: 200,
        json: async () => ({ rate_limit: { primary_window: { used_percent: 12 } } }),
      };
    },
  });

  assert.deepEqual(calls, ['proxy', 'fetch']);
  assert.equal(usage.rate_limit.primary_window.used_percent, 12);
});

test('Codex certificate failures become a clear local-snapshot warning', () => {
  const err = new Error('unable to get local issuer certificate');
  assert.equal(describeLiveError(err), '网络证书无法验证，当前显示本地快照');
});

test('Codex non-success response is not silently treated as live data', async () => {
  await assert.rejects(
    fetchCodexOAuthUsage({
      readTokensImpl: async () => ({ access_token: 'token' }),
      refreshProxyImpl() {},
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /Codex usage HTTP 429/,
  );
});

test('Codex app-server response is normalized to the existing quota shape', () => {
  const usage = normalizeAppServerUsage({
    rateLimits: {
      primary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: 1788272195 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1787751865 },
      planType: 'prolite',
    },
  });
  assert.equal(usage.plan_type, 'prolite');
  assert.deepEqual(usage.rate_limit.primary_window, {
    used_percent: 6,
    limit_window_seconds: 604800,
    reset_at: 1788272195,
  });
  assert.equal(usage.rate_limit.secondary_window.limit_window_seconds, 18000);
});

test('Codex app-server handshake returns live account rate limits', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString();
    const lines = input.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (lines.some(x => x.id === 1)) {
      child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'Codex' } })}\n`);
    }
    if (lines.some(x => x.id === 2)) {
      child.stdout.write(`${JSON.stringify({
        id: 2,
        result: {
          rateLimits: {
            primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1788272195 },
            secondary: null,
            planType: 'prolite',
          },
        },
      })}\n`);
    }
  });

  let proxyRefreshes = 0;
  const usage = await fetchCodexAppServerUsage({
    binary: '/fake/codex',
    spawnImpl: () => child,
    refreshProxyImpl: () => { proxyRefreshes++; return { source: 'system', url: 'http://127.0.0.1:7890' }; },
    timeoutMs: 1000,
  });
  assert.equal(proxyRefreshes, 1);
  assert.equal(usage.rate_limit.primary_window.used_percent, 7);
});
