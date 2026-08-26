const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUpdater, cmpVer, parseVer, pickDmgAsset } = require('../src/server/services/updater');
const { createUpdateRouter } = require('../src/server/routes/update');

const RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/xiexiixixi/mana/releases/tag/v9.9.9',
  body: 'release notes here',
  published_at: '2026-08-23T00:00:00Z',
  assets: [{ name: 'Mana.dmg', browser_download_url: 'https://dl/Mana.dmg', size: 41 }],
};

test('parseVer strips v prefix and tolerates junk', () => {
  assert.deepEqual(parseVer('v0.2.10'), [0, 2, 10]);
  assert.deepEqual(parseVer('0.2.10'), [0, 2, 10]);
  assert.deepEqual(parseVer(''), [0]);
  assert.deepEqual(parseVer('x'), [0]);
});

test('cmpVer semver ordering', () => {
  assert.equal(cmpVer('0.2.9', '0.2.10') < 0, true);
  assert.equal(cmpVer('v0.2.10', '0.2.9') > 0, true);
  assert.equal(cmpVer('0.2.10', '0.2.10'), 0);
  assert.equal(cmpVer('1.0', '1.0.0'), 0);
  assert.equal(cmpVer('0.10.0', '0.9.9') > 0, true);
});

test('pickDmgAsset: first dmg, arm64 preferred, ignores non-dmg', () => {
  assert.equal(pickDmgAsset([{ name: 'Mana.dmg', browser_download_url: 'u1' }]).browser_download_url, 'u1');
  assert.equal(pickDmgAsset([{ name: 'src.zip' }]), null);
  assert.equal(pickDmgAsset([]), null);
  const mixed = pickDmgAsset([
    { name: 'Mana-x64.dmg', browser_download_url: 'u2' },
    { name: 'Mana-arm64.dmg', browser_download_url: 'u3' },
  ]);
  assert.equal(mixed.browser_download_url, 'u3');
});

test('check parses release, compares to current, returns dmg url', async () => {
  let proxyRefreshes = 0;
  const upd = createUpdater({
    fetchImpl: async () => ({ ok: true, json: async () => RELEASE }),
    currentVersion: () => '0.2.9',
    refreshProxyImpl: () => { proxyRefreshes++; },
  });
  const r = await upd.check({ force: true });
  assert.equal(proxyRefreshes, 1);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.latest, '9.9.9');
  assert.equal(r.current, '0.2.9');
  assert.equal(r.dmgUrl, 'https://dl/Mana.dmg');
  assert.equal(r.error, null);
});

test('check: same version → no update; dev current → never update', async () => {
  const mk = (cur) => createUpdater({
    fetchImpl: async () => ({ ok: true, json: async () => RELEASE }),
    currentVersion: () => cur,
  });
  assert.equal((await mk('9.9.9').check({ force: true })).hasUpdate, false);
  assert.equal((await mk('dev').check({ force: true })).hasUpdate, false);
});

test('check caches: second non-force call does not refetch', async () => {
  let calls = 0;
  const upd = createUpdater({
    fetchImpl: async () => { calls++; return { ok: true, json: async () => RELEASE }; },
    currentVersion: () => '0.2.9',
  });
  await upd.check({ force: true });
  const r2 = await upd.check();
  assert.equal(calls, 1);
  assert.equal(r2.hasUpdate, true);
});

test('check failure falls back to last good cache with error flag', async () => {
  let fail = false;
  const upd = createUpdater({
    fetchImpl: async () => {
      if (fail) throw new Error('GitHub API 503');
      return { ok: true, json: async () => RELEASE };
    },
    requestImpl: async () => { throw new Error('network down'); }, // API 与 302 兜底全挂
    currentVersion: () => '0.2.9',
  });
  await upd.check({ force: true });
  fail = true;
  const r = await upd.check({ force: true });
  assert.equal(r.hasUpdate, true); // 缓存数据还在
  assert.equal(r.error, 'network down');
});

test('API 403 rate limit → 302 redirect fallback with deterministic dmg url', async () => {
  const upd = createUpdater({
    fetchImpl: async () => { throw new Error('GitHub API 403'); },
    requestImpl: async () => ({ statusCode: 302, headers: { location: 'https://github.com/xiixiixixi/mana/releases/tag/v9.9.9' } }),
    currentVersion: () => '0.2.9',
  });
  const r = await upd.check({ force: true });
  assert.equal(r.source, 'redirect');
  assert.equal(r.latest, '9.9.9');
  assert.equal(r.hasUpdate, true);
  assert.equal(r.dmgUrl, 'https://github.com/xiixiixixi/mana/releases/download/v9.9.9/Mana.dmg');
  assert.equal(r.error, null);
});

test('both API and redirect fail → error placeholder, no update', async () => {
  const upd = createUpdater({
    fetchImpl: async () => { throw new Error('GitHub API 403'); },
    requestImpl: async () => ({ statusCode: 404, headers: {} }),
    currentVersion: () => '0.2.9',
  });
  const r = await upd.check({ force: true });
  assert.equal(r.hasUpdate, false);
  assert.match(r.error, /releases\/latest/);
});

test('GET /api/update/status|check returns updater payload', async () => {
  const express = require('express');
  const upd = createUpdater({
    fetchImpl: async () => ({ ok: true, json: async () => RELEASE }),
    currentVersion: () => '0.2.9',
  });
  const app = express().use('/api', createUpdateRouter(upd));
  const server = app.listen(0);
  const port = server.address().port;
  const r = await (await fetch(`http://127.0.0.1:${port}/api/update/status`)).json();
  assert.equal(r.latest, '9.9.9');
  assert.equal(r.hasUpdate, true);
  server.close();
});
