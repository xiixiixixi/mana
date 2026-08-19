const { BaseProvider } = require('./base');
const { formatResetAt } = require('./common');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 数据来源（按优先级）:
// 1. Codex OAuth usage API（账号级实时配额；本网络下 chatgpt.com 可能被 Cloudflare 拦，
//    失败自动回退 2）——token 从 ~/.codex/auth.json 读取，过期用 refresh_token 刷新并回写
// 2. ~/.codex/sessions/**/rollout-*.jsonl 最后一条 rate_limits（本地 CLI 快照，可能滞后）
// 3. ~/.codex/state_5.sqlite — 累计 token

const CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';

async function readCodexTokens() {
  try {
    const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'));
    if (a.tokens?.access_token) {
      return { access_token: a.tokens.access_token, refresh_token: a.tokens.refresh_token, account_id: a.account_id || a.tokens.account_id || null };
    }
  } catch {}
  return null;
}

// 刷新并回写（refresh_token 单次使用，必须立即持久化新令牌，否则会把 codex CLI 的登录搞坏）
async function refreshCodexTokens(refreshToken) {
  const res = await fetch(CODEX_REFRESH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`refresh HTTP ${res.status}`);
  const t = await res.json();
  try {
    const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'));
    a.tokens.access_token = t.access_token;
    if (t.refresh_token) a.tokens.refresh_token = t.refresh_token;
    if (t.id_token) a.tokens.id_token = t.id_token;
    if (t.account_id) a.tokens.account_id = t.account_id;
    a.last_refresh = new Date().toISOString();
    fs.writeFileSync(CODEX_AUTH, JSON.stringify(a, null, 2));
  } catch {}
  return { access_token: t.access_token, account_id: t.account_id || null };
}

// 返回 {rate_limit, plan_type} 或 null（网络/风控不可达时）
async function fetchCodexOAuthUsage() {
  let tok = await readCodexTokens();
  if (!tok) return null;
  const call = (token) => fetch(CODEX_USAGE_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'codex_cli_rs/0.55.0 (Mac OS 15.0; arm64) unknown (unknown)',
      'originator': 'codex_cli_rs',
      'Accept': 'application/json',
      ...(tok.account_id ? { 'ChatGPT-Account-Id': String(tok.account_id) } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  let res = await call(tok.access_token);
  if (res.status === 401 || res.status === 403) {
    // token 过期 → 刷新后重试一次
    if (!tok.refresh_token) return null;
    const fresh = await refreshCodexTokens(tok.refresh_token);
    if (fresh.account_id && !tok.account_id) tok.account_id = fresh.account_id;
    res = await call(fresh.access_token);
  }
  if (!res.ok) return null; // 403=Cloudflare 拦截等，交给本地快照回退
  return await res.json();
}

class CodexProvider extends BaseProvider {
  constructor() {
    super({
      id: 'codex', name: 'Codex', icon: 'CX',
      color: '#10a37f', colorDim: 'rgba(16,163,127,0.12)',
      consoleUrl: 'https://chatgpt.com/codex/usage',
      apiType: 'local', region: 'global', cacheTTL: 30,
    });
  }

  // 本机没有 ~/.codex（未装 Codex CLI）时整个平台不进首页
  isConfigured() {
    const c = path.join(os.homedir(), '.codex');
    return fs.existsSync(path.join(c, 'auth.json'))
      || fs.existsSync(path.join(c, 'state_5.sqlite'))
      || fs.existsSync(path.join(c, 'sessions'));
  }

  async fetchUsage() {
    const homeDir = os.homedir();

    // 1. 优先 OAuth 实时配额
    const oauth = await fetchCodexOAuthUsage().catch(() => null);
    if (oauth?.rate_limit) {
      const quotas = [];
      const windowMeta = (m) => {
        if (m <= 300) return { label: '5h 窗口', window: '5h' };
        if (m <= 1440) return { label: '每日额度', window: '1d' };
        if (m <= 10080) return { label: '每周额度', window: '7d' };
        return { label: '每月额度', window: '30d' };
      };
      for (const w of [oauth.rate_limit.primary_window, oauth.rate_limit.secondary_window]) {
        if (!w) continue;
        const meta = windowMeta(w.window_minutes || 10080);
        quotas.push({
          label: meta.label,
          used: w.used_percent,
          total: 100, unit: '%',
          resetIn: w.resets_at ? formatResetAt(w.resets_at * 1000) : null,
          window: meta.window,
        });
      }
      if (quotas.length) {
        return this.buildUsage({ status: 'active', plan: oauth.plan_type || 'Codex', quotas });
      }
    }

    // 2. 回退：本地 rollout 快照（标注数据时点，避免把旧值当实时）
    const snapshot = this.readLatestRateLimits(homeDir);
    const rateLimits = snapshot?.rateLimits;
    const staleNote = snapshot?.mtime
      ? `本地快照 ${snapshot.mtime.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})} ${snapshot.mtime.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`
      : '';

    const dbPath = path.join(homeDir, '.codex', 'state_5.sqlite');
    let totalTokens = 0;
    let plan = [rateLimits?.plan_type, staleNote].filter(Boolean).join(' · ') || 'Local';

    if (fs.existsSync(dbPath)) {
      try {
        const sql = `SELECT SUM(tokens_used) as total FROM threads WHERE tokens_used > 0`;
        const raw = execSync(`sqlite3 -cmd ".timeout 1500" '${dbPath}' -json "${sql}"`, {
          encoding: 'utf8', timeout: 5000,
        });
        const rows = JSON.parse(raw || '[]');
        totalTokens = rows[0]?.total || 0;
      } catch {}
    }

    // Build quotas from rate limits
    const quotas = [];

    if (rateLimits) {
      // 窗口类型由 window_minutes 决定，与 primary/secondary 位置无关
      // （实测 primary 常为周窗口 10080min；5h 窗口出现在任一位置都按分钟数判别）
      const windowMeta = (m) => {
        if (m <= 300) return { label: '5h 窗口', window: '5h' };
        if (m <= 1440) return { label: '每日额度', window: '1d' };
        if (m <= 10080) return { label: '每周额度', window: '7d' };
        return { label: '每月额度', window: '30d' };
      };
      for (const w of [rateLimits.primary, rateLimits.secondary]) {
        if (!w) continue;
        const meta = windowMeta(w.window_minutes || 10080);
        quotas.push({
          label: meta.label,
          used: w.used_percent,
          total: 100,
          unit: '%',
          resetIn: w.resets_at ? formatResetAt(w.resets_at * 1000) : null,
          window: meta.window,
        });
      }
    }

    // Always show total usage
    quotas.push({
      label: '累计 · 全部历史',
      used: 0, total: 0,
      unit: totalTokens >= 1e9 ? 'B tok' : totalTokens >= 1e6 ? 'M tok' : 'k tok',
      balance: totalTokens >= 1e9
        ? Math.round(totalTokens / 1e9 * 100) / 100
        : totalTokens >= 1e6
          ? Math.round(totalTokens / 1e6 * 100) / 100
          : Math.round(totalTokens / 1e3 * 100) / 100,
      resetIn: null, window: null,
    });

    if (quotas.length === 0) {
      throw new Error('Codex 无数据');
    }

    return this.buildUsage({
      status: 'active',
      plan: `ChatGPT ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      quotas,
    });
  }

  readLatestRateLimits(homeDir) {
    const sessionsDir = path.join(homeDir, '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    // Find latest rollout file by mtime across all directories
    let latestFile = null;
    let latestTime = 0;

    const walkDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > latestTime) {
              latestTime = stat.mtimeMs;
              latestFile = fullPath;
            }
          }
        }
      } catch {}
    };

    try {
      walkDir(sessionsDir);
    } catch {}

    if (!latestFile) return null;

    // Parse last token_count event for rate_limits
    try {
      const content = fs.readFileSync(latestFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.payload?.type === 'token_count' && obj.payload?.rate_limits) {
            const rl = obj.payload.rate_limits;
            const now = Date.now();
            // Check if 5h window has expired
            if (rl.primary?.resets_at && rl.primary.resets_at * 1000 < now) {
              rl.primary.used_percent = 0;
            }
            // Check if 7d window has expired
            if (rl.secondary?.resets_at && rl.secondary.resets_at * 1000 < now) {
              rl.secondary.used_percent = 0;
            }
            return { rateLimits: rl, mtime: new Date(latestTime) };
          }
        } catch {}
      }
    } catch {}

    return null;
  }

  validateKey() { return true; }
}

module.exports = { CodexProvider };
