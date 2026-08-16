const { BaseProvider } = require('./base');
const { formatResetAt } = require('./common');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 数据来源:
// 1. ~/.codex/state_5.sqlite — 已用 token
// 2. ~/.codex/sessions/**/rollout-*.jsonl — rate_limits（5h/7d 窗口）

class CodexProvider extends BaseProvider {
  constructor() {
    super({
      id: 'codex', name: 'Codex', icon: 'CX',
      color: '#10a37f', colorDim: 'rgba(16,163,127,0.12)',
      consoleUrl: 'https://chatgpt.com/codex/usage',
      apiType: 'local', region: 'global', cacheTTL: 30,
    });
  }

  async fetchUsage() {
    const homeDir = os.homedir();

    // 1. Read rate limits from latest session file
    const rateLimits = this.readLatestRateLimits(homeDir);

    // 2. Read total usage from SQLite
    const dbPath = path.join(homeDir, '.codex', 'state_5.sqlite');
    let totalTokens = 0;
    let plan = rateLimits?.plan_type || 'Local';

    if (fs.existsSync(dbPath)) {
      try {
        const sql = `SELECT SUM(tokens_used) as total FROM threads WHERE tokens_used > 0`;
        const raw = execSync(`sqlite3 '${dbPath}' -json "${sql}"`, {
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
      label: '累计用量',
      used: 0, total: 0, unit: 'M tokens',
      balance: Math.round(totalTokens / 1e6 * 100) / 100,
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
            return rl;
          }
        } catch {}
      }
    } catch {}

    return null;
  }

  validateKey() { return true; }
}

module.exports = { CodexProvider };
