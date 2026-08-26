const fs = require('fs');
const path = require('path');
const { request, getGlobalDispatcher } = require('undici');

// 自更新检查：监控本仓库 GitHub Release（xiexiixixi/mana）。
// Node 只负责"检查"（undici 走 proxy.js 的全局代理），下载/替换/重启在 Swift 壳
// （main.swift SelfUpdate 段）。版本号唯一来源是 package.json，build.sh 把它写进
// Resources/version 供打包态读取；开发态直接读 package.json（current=dev 时永不提示更新）。
const REPO = 'xiixiixixi/mana'; // 注意：git remote 还是改名前的 xiexiixixi/mana（GitHub 自动重定向）
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_MS = 10 * 60 * 1000;   // Swift 每 180s 轮询 /api/update/status，命中缓存不打 GitHub
const STALE_OK_MS = 24 * 3600 * 1000; // 网络失败时最多回退到 24h 内的旧缓存
const TIMEOUT_MS = 15 * 1000;

function parseVer(s) {
  return String(s || '').replace(/^[vV]/, '').split('.').map(p => parseInt(p, 10) || 0);
}

function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function readCurrentVersion() {
  // 打包态：Resources/version（build.sh 写入）；开发态：仓库 package.json
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'version'), 'utf8').trim();
    if (v) return v;
  } catch {}
  try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch {}
  return 'dev';
}

function pickDmgAsset(assets) {
  const list = (Array.isArray(assets) ? assets : []).filter(a => /\.dmg$/i.test(a.name || ''));
  // 资产固定名 Mana.dmg；若未来分架构，优先 arm64
  return list.find(a => /arm64/i.test(a.name)) || list[0] || null;
}

async function defaultRequest(url, opts) { return request(url, opts); }

function createUpdater({
  fetchImpl = fetch,
  requestImpl = defaultRequest,
  currentVersion = readCurrentVersion,
  refreshProxyImpl = () => {},
} = {}) {
  let cache = null; // { result, at }
  let inflight = null;

  async function fetchOnce() {
    // 用户可能在 Mana 运行期间切换代理；每次真正联网前刷新一次全局 dispatcher。
    await refreshProxyImpl();
    // 主路：GitHub API（有 notes/资产元数据）。共享代理出口 IP 常把 60/h 未认证配额耗尽 → 403
    try {
      const res = await fetchImpl(API_URL, {
        headers: { 'User-Agent': 'mana-updater', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const j = await res.json();
      const latest = String(j.tag_name || '').replace(/^[vV]/, '');
      const asset = pickDmgAsset(j.assets);
      if (!latest || !asset) throw new Error('release missing version or dmg asset');
      return buildResult(latest, asset.browser_download_url, {
        dmgSize: asset.size || null,
        releaseUrl: j.html_url || `https://github.com/${REPO}/releases`,
        notes: String(j.body || '').slice(0, 800),
        publishedAt: j.published_at || null,
        source: 'api',
      });
    } catch (apiErr) {
      // 兜底：releases/latest 302 跳转拿 tag（非 API，无配额）；资产名固定 Mana.dmg（build.sh 产物）
      const fb = await fetchTagViaRedirect();
      return buildResult(fb.latest, `https://github.com/${REPO}/releases/download/${fb.tag}/Mana.dmg`, {
        dmgSize: null, releaseUrl: `https://github.com/${REPO}/releases`, notes: null,
        publishedAt: null, source: 'redirect', apiError: apiErr.message,
      });
    }
  }

  async function fetchTagViaRedirect() {
    const res = await requestImpl(`https://github.com/${REPO}/releases/latest`, {
      dispatcher: getGlobalDispatcher(),
      redirect: 'manual',
      headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'mana-updater' },
    });
    const loc = String(res.headers['location'] || '');
    const tag = loc.split('/tag/')[1] || '';
    if (res.statusCode !== 302 || !tag) throw new Error(`github.com releases/latest ${res.statusCode}`);
    return { tag, latest: tag.replace(/^[vV]/, '') };
  }

  function buildResult(latest, dmgUrl, extra) {
    const current = currentVersion();
    return {
      current,
      latest,
      hasUpdate: current !== 'dev' && cmpVer(latest, current) > 0,
      dmgUrl,
      checkedAt: new Date().toISOString(),
      error: null,
      ...extra,
    };
  }

  // check({force})：force 绕过缓存（手动"检查更新"按钮）；否则 10min 内直接回缓存
  function check({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.result);
    if (inflight) return inflight;
    inflight = fetchOnce()
      .then(result => { cache = { result, at: Date.now() }; return result; })
      .catch(err => {
        // 更新检查失败绝不影响主功能：优先回 24h 内的旧缓存，否则返回 error 占位
        if (cache && Date.now() - cache.at < STALE_OK_MS) return { ...cache.result, error: err.message };
        return {
          current: currentVersion(), latest: null, hasUpdate: false, dmgUrl: null,
          releaseUrl: null, notes: null, publishedAt: null,
          checkedAt: new Date().toISOString(), error: err.message,
        };
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { check };
}

module.exports = { createUpdater, cmpVer, parseVer, pickDmgAsset, readCurrentVersion, API_URL };
