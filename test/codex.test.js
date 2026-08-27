const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  CodexProvider,
  fetchCodexOAuthUsage,
  fetchCodexAppServerUsage,
  normalizeAppServerUsage,
  normalizeAppServerAccountUsage,
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

test('Codex account usage keeps valid official daily token buckets', () => {
  assert.deepEqual(normalizeAppServerAccountUsage({
    summary: { lifetimeTokens: 1234, peakDailyTokens: 800 },
    dailyUsageBuckets: [
      { startDate: '2026-08-25', tokens: 800 },
      { startDate: 'bad-date', tokens: 99 },
      { startDate: '2026-08-24', tokens: -1 },
    ],
  }), {
    summary: { lifetimeTokens: 1234, peakDailyTokens: 800 },
    dailyUsageBuckets: [{ startDate: '2026-08-25', tokens: 800 }],
    latestDate: '2026-08-25',
  });
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
    if (lines.some(x => x.id === 3)) {
      child.stdout.write(`${JSON.stringify({
        id: 3,
        result: {
          summary: { lifetimeTokens: 9000 },
          dailyUsageBuckets: [{ startDate: '2026-08-25', tokens: 9000 }],
          threadUsage: null,
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
  assert.equal(usage.accountTokenUsage.latestDate, '2026-08-25');
  assert.equal(usage.accountTokenUsage.dailyUsageBuckets[0].tokens, 9000);
});

test('旧版 Codex 不支持账户日桶时仍返回实时配额', async () => {
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
        result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: null } },
      })}\n`);
    }
    if (lines.some(x => x.id === 3)) {
      child.stdout.write(`${JSON.stringify({ id: 3, error: { message: 'method not found' } })}\n`);
    }
  });

  const usage = await fetchCodexAppServerUsage({
    binary: '/fake/codex',
    spawnImpl: () => child,
    refreshProxyImpl: () => ({ source: null, url: null }),
    timeoutMs: 1000,
  });
  assert.equal(usage.rate_limit.primary_window.used_percent, 12);
  assert.equal(usage.accountTokenUsage, null);
});

test('Codex provider exposes official account buckets separately from quotas', async () => {
  const provider = new CodexProvider({
    fetchCodexAppServerUsage: async () => ({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: null },
        secondary_window: null,
      },
      accountTokenUsage: {
        summary: { lifetimeTokens: 1000 },
        dailyUsageBuckets: [{ startDate: '2026-08-25', tokens: 1000 }],
        latestDate: '2026-08-25',
      },
    }),
  });
  const result = await provider.fetchUsage();
  assert.equal(result.quotas[0].label, '5h 窗口');
  assert.equal(result.accountTokenUsage.latestDate, '2026-08-25');
  assert.equal(result.accountTokenUsage.dailyUsageBuckets[0].tokens, 1000);
});
