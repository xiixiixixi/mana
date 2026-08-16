const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { calcCost } = require('./modelPricing');
const { weightedTokens } = require('./weighted');

const CLAUDE_DIR = path.join(process.env.HOME || '/root', '.claude', 'projects');
const CODEX_DB = path.join(process.env.HOME || '/root', '.codex', 'state_5.sqlite');
const OPENCODE_DB = path.join(process.env.HOME || '/root', '.local', 'share', 'opencode', 'opencode.db');

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

function createLocalUsageService() {
  let cached = null;
  let cachedAt = 0;
  const TTL = 5 * 60 * 1000;

  function isStale() {
    return !cached || (Date.now() - cachedAt) > TTL;
  }

  async function get() {
    if (!isStale()) return cached;

    const [claude, codex, opencode] = await Promise.all([
      scanClaudeSessions(),
      scanCodexUsage(),
      scanOpenCodeUsage(),
    ]);

    const sessions = buildSessionAnalysis(claude);

    cached = { claude, codex, opencode, sessions, fetchedAt: Date.now() };
    cachedAt = Date.now();
    return cached;
  }

  return { get };
}

// ── Claude Code JSONL ──────────────────────────────────────

async function scanClaudeSessions() {
  if (!fs.existsSync(CLAUDE_DIR)) return emptyResult();

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dailyMap = {};
  const allMessages = [];

  // 递归收集 *.jsonl：Claude Code 的会话文件在 projects/<项目>/<sessionId>/ 子目录
  // （以及 memory/、subagents/），只扫第一层会漏掉绝大多数文件
  const jsonlFiles = [];
  (function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) jsonlFiles.push(p);
    }
  })(CLAUDE_DIR, 0);

  const seen = new Set(); // 跨会话文件的消息去重（resume/fork 复制场景）
  for (const filePath of jsonlFiles) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) continue;
    } catch { continue; }
    await parseJsonl(filePath, dailyMap, allMessages, seen);
  }

  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  return buildResult(dailyMap, allMessages);
}

// 本地日期（YYYY-MM-DD，按用户时区切日；此前用 UTC 切片导致"今日"边界差 8 小时）
function localDate(input) {
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseJsonl(filePath, dailyMap, allMessages, seen) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      if (!line) return;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant' || !obj.message?.usage) return;

        const usage = obj.message.usage;
        // 注意：不能按 input_tokens===0 过滤——开启 prompt caching 后绝大多数消息
        // input_tokens 为 0（输入全在 cache_read/cache_creation），过滤会把它们的
        // output+cache 全部丢掉，导致严重少计（实测对比 ccusage 差 50 倍以上）。
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreate = usage.cache_creation_input_tokens || 0;
        if (inputTokens + outputTokens + cacheRead + cacheCreate === 0) return;

        const model = obj.message.model || 'unknown';
        const ts = obj.timestamp;
        if (!ts) return;

        // 跨文件去重：resume/fork 会把旧消息复制进新会话文件，message.id 相同
        const dedupKey = obj.message.id
          ? obj.message.id
          : `${ts}|${model}|${inputTokens}|${outputTokens}|${cacheRead}|${cacheCreate}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        const date = localDate(ts);
        const key = `${date}|${model}`;
        if (!dailyMap[key]) {
          dailyMap[key] = { date, model, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, weightedTokens: 0, costUSD: 0 };
        }
        dailyMap[key].inputTokens += inputTokens;
        dailyMap[key].outputTokens += outputTokens;
        dailyMap[key].cacheRead += cacheRead;
        dailyMap[key].cacheCreate += cacheCreate;
        dailyMap[key].weightedTokens += weightedTokens(inputTokens, outputTokens, cacheRead, cacheCreate);

        allMessages.push({
          timestamp: new Date(ts).getTime(),
          model,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreate,
          totalTokens: weightedTokens(inputTokens, outputTokens, cacheRead, cacheCreate), // 会话分析口径 = 计费等效
          costUSD: calcCost(model, inputTokens, outputTokens, cacheRead, cacheCreate),
        });
      } catch {}
    });

    rl.on('close', resolve);
    stream.on('error', resolve);
  });
}

// ── Session Analysis (from Claude-Code-Usage-Monitor) ─────

function buildSessionAnalysis(claudeData) {
  const allMessages = claudeData.allMessages || [];
  if (allMessages.length === 0) {
    return { currentSession: null, burnRate: null, p90: null, prediction: null };
  }

  const now = Date.now();

  // Group messages into 5-hour sessions using greedy windowing
  const sessions = [];
  let windowStart = allMessages[0].timestamp;
  let windowTokens = 0;
  let windowMessages = [];

  for (const msg of allMessages) {
    if (msg.timestamp - windowStart > SESSION_WINDOW_MS) {
      if (windowTokens > 0) {
        sessions.push({
          start: windowStart,
          end: windowMessages[windowMessages.length - 1].timestamp,
          tokens: windowTokens,
          messages: windowMessages.length,
          cost: windowMessages.reduce((s, m) => s + m.costUSD, 0),
        });
      }
      windowStart = msg.timestamp;
      windowTokens = 0;
      windowMessages = [];
    }
    windowTokens += msg.totalTokens;
    windowMessages.push(msg);
  }
  if (windowTokens > 0) {
    sessions.push({
      start: windowStart,
      end: windowMessages[windowMessages.length - 1].timestamp,
      tokens: windowTokens,
      messages: windowMessages.length,
      cost: windowMessages.reduce((s, m) => s + m.costUSD, 0),
    });
  }

  // Current session = most recent session
  const currentSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  // Burn rate: tokens per minute in the last hour
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentMessages = allMessages.filter(m => m.timestamp > oneHourAgo);
  let burnRate = null;
  if (recentMessages.length >= 2) {
    const timeSpanMin = (recentMessages[recentMessages.length - 1].timestamp - recentMessages[0].timestamp) / 60000;
    if (timeSpanMin > 0) {
      const totalRecent = recentMessages.reduce((s, m) => s + m.totalTokens, 0);
      burnRate = {
        tokensPerMinute: Math.round(totalRecent / timeSpanMin),
        tokensPerHour: Math.round(totalRecent / timeSpanMin * 60),
        costPerHour: Math.round(recentMessages.reduce((s, m) => s + m.costUSD, 0) / timeSpanMin * 60 * 100) / 100,
        sampleSize: recentMessages.length,
      };
    }
  }

  // P90 limit detection
  const sessionTokens = sessions.map(s => s.tokens).sort((a, b) => a - b);
  let p90 = null;
  if (sessionTokens.length >= 3) {
    const idx = Math.ceil(sessionTokens.length * 0.9) - 1;
    p90 = {
      limit: sessionTokens[idx],
      maxObserved: sessionTokens[sessionTokens.length - 1],
      sessions: sessionTokens.length,
      percentile: 90,
    };
  }

  // Session expiry prediction
  let prediction = null;
  if (currentSession && burnRate && burnRate.tokensPerMinute > 0) {
    const elapsed = now - currentSession.start;
    const remaining = SESSION_WINDOW_MS - elapsed;
    const windowRemainMin = Math.max(0, remaining / 60000);

    // Predict based on burn rate
    const estimatedLimit = p90 ? p90.limit : currentSession.tokens * 1.5;
    const remainingTokens = Math.max(0, estimatedLimit - currentSession.tokens);
    const burnTimeMin = remainingTokens / burnRate.tokensPerMinute;
    const limitHitsFirst = burnTimeMin < windowRemainMin;
    const predictedMinutes = limitHitsFirst ? burnTimeMin : windowRemainMin;

    prediction = {
      windowExpiresInMin: Math.round(windowRemainMin),
      limitHitsInMin: limitHitsFirst ? Math.round(burnTimeMin) : null,
      predictedEndInMin: Math.round(predictedMinutes),
      estimatedLimit,
      confidence: sessionTokens.length >= 5 ? 'high' : sessionTokens.length >= 3 ? 'medium' : 'low',
    };
  }

  return {
    currentSession,
    burnRate,
    p90,
    prediction,
    totalSessions: sessions.length,
    recentSessions: sessions.slice(-10),
  };
}

// ── Codex SQLite ──────────────────────────────────────

async function scanCodexUsage() {
  if (!fs.existsSync(CODEX_DB)) return emptyResult();

  const dailyMap = {};
  try {
    const sql = `SELECT model, tokens_used, updated_at FROM threads WHERE tokens_used > 0`;
    const raw = execSync(`sqlite3 '${CODEX_DB}' -json "${sql}"`, {
      encoding: 'utf8', timeout: 5000,
    });
    const rows = JSON.parse(raw || '[]');

    for (const row of rows) {
      const model = row.model || null;
      if (!model) continue;
      const tokens = row.tokens_used || 0;
      const date = localDate(row.updated_at * 1000);

      const key = `${date}|${model}`;
      if (!dailyMap[key]) {
        dailyMap[key] = { date, model, inputTokens: 0, outputTokens: tokens, cacheRead: 0, cacheCreate: 0, costUSD: 0 };
      } else {
        dailyMap[key].outputTokens += tokens;
      }
    }
  } catch {
    return emptyResult();
  }

  return buildResult(dailyMap);
}

// ── OpenCode SQLite ──────────────────────────────────────

async function scanOpenCodeUsage() {
  if (!fs.existsSync(OPENCODE_DB)) return emptyResult();

  const dailyMap = {};
  try {
    const sql = `SELECT model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created
      FROM session WHERE tokens_input > 0 OR tokens_output > 0`;
    const raw = execSync(`sqlite3 '${OPENCODE_DB}' -json "${sql}"`, {
      encoding: 'utf8', timeout: 5000,
    });
    const rows = JSON.parse(raw || '[]');

    for (const row of rows) {
      let modelName = 'unknown';
      try {
        const m = JSON.parse(row.model);
        modelName = m.id || 'unknown';
      } catch {}

      const cost = parseFloat(row.cost) || 0;
      const date = localDate(row.time_created);

      const key = `${date}|${modelName}`;
      if (!dailyMap[key]) {
        dailyMap[key] = { date, model: modelName, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0 };
      }
      const entry = dailyMap[key];
      entry.inputTokens += row.tokens_input || 0;
      entry.outputTokens += row.tokens_output || 0;
      entry.cacheRead += row.tokens_cache_read || 0;
      entry.cacheCreate += row.tokens_cache_write || 0;
      entry.costUSD += cost;
    }
  } catch {
    return emptyResult();
  }

  return buildResult(dailyMap);
}

// ── Helpers ──────────────────────────────────────

function emptyResult() {
  return { daily: [], summary: { todayTokens: 0, weekTokens: 0, monthTokens: 0, todayCost: 0, weekCost: 0, monthCost: 0, byModel: {} }, allMessages: [] };
}

function buildResult(dailyMap, allMessages) {
  const entries = Object.values(dailyMap);

  for (const e of entries) {
    if (e.costUSD === 0) {
      e.costUSD = calcCost(e.model, e.inputTokens, e.outputTokens, e.cacheRead, e.cacheCreate);
    }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  // 今日/本周/本月按本地时区切日（与 daily 桶一致）
  const today = localDate(Date.now());
  const weekAgo = localDate(Date.now() - 7 * 86400000);
  const monthAgo = localDate(Date.now() - 30 * 86400000);

  const summary = { todayTokens: 0, weekTokens: 0, monthTokens: 0, todayCost: 0, weekCost: 0, monthCost: 0, byModel: {} };

  for (const e of entries) {
    // 主口径 = 计费等效 tokens（缓存读 0.1×/写 1.25×），原始分项保留在 daily 条目里
    const tokens = e.weightedTokens != null ? e.weightedTokens : (e.inputTokens + e.outputTokens + e.cacheRead + e.cacheCreate);

    if (e.model && e.model !== 'unknown') {
      if (!summary.byModel[e.model]) summary.byModel[e.model] = { today: 0, week: 0, month: 0, total: 0, cost: 0 };
      if (e.date === today) summary.byModel[e.model].today += tokens;
      if (e.date >= weekAgo) summary.byModel[e.model].week += tokens;
      if (e.date >= monthAgo) summary.byModel[e.model].month += tokens;
      summary.byModel[e.model].total += tokens;
      summary.byModel[e.model].cost += e.costUSD;
    }

    if (e.date >= monthAgo) {
      summary.monthTokens += tokens;
      summary.monthCost += e.costUSD;
    }
    if (e.date >= weekAgo) {
      summary.weekTokens += tokens;
      summary.weekCost += e.costUSD;
    }
    if (e.date === today) {
      summary.todayTokens += tokens;
      summary.todayCost += e.costUSD;
    }
  }

  summary.todayCost = Math.round(summary.todayCost * 100) / 100;
  summary.weekCost = Math.round(summary.weekCost * 100) / 100;
  summary.monthCost = Math.round(summary.monthCost * 100) / 100;
  for (const m of Object.values(summary.byModel)) {
    m.cost = Math.round(m.cost * 100) / 100;
  }

  return { daily: entries, summary, allMessages };
}

module.exports = { createLocalUsageService };
