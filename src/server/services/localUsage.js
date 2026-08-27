const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { calcCost } = require('./modelPricing');
const { weightedTokens } = require('./weighted');

const CLAUDE_DIR = path.join(process.env.HOME || '/root', '.claude', 'projects');
const CODEX_DB = path.join(process.env.HOME || '/root', '.codex', 'state_5.sqlite');
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || '/root', '.codex', 'sessions');
const OPENCODE_DB = path.join(process.env.HOME || '/root', '.local', 'share', 'opencode', 'opencode.db');
const ZCODE_DB = path.join(process.env.HOME || '/root', '.zcode', 'cli', 'db', 'db.sqlite');

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const codexRolloutCache = new Map();

function createLocalUsageService() {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  const TTL = 60 * 1000;

  function isStale() {
    return !cached || (Date.now() - cachedAt) > TTL;
  }

  async function get() {
    if (!isStale()) return cached;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const now = Date.now();
      const [claude, codex, opencode, zcode] = await Promise.all([
        scanClaudeUsage(now),
        scanCodexUsage(now),
        scanOpenCodeUsage(now),
        scanZcodeUsage(now),
      ]);

      const sessions = buildSessionAnalysis(claude);
      cached = { claude, codex, opencode, zcode, sessions, fetchedAt: Date.now() };
      cachedAt = Date.now();
      return cached;
    })();

    try { return await inFlight; }
    finally { inFlight = null; }
  }

  return { get };
}

// ── Claude Code JSONL ──────────────────────────────────────

function attachSource(result, source) {
  return { ...result, source };
}

async function scanClaudeUsage(now = Date.now(), claudeDir = CLAUDE_DIR) {
  const result = await scanClaudeSessions(now, claudeDir);
  return attachSource(result, {
    kind: 'tool-records',
    label: 'Claude Code 自带会话记录',
    status: fs.existsSync(claudeDir) ? 'ok' : 'unavailable',
    note: 'Claude Code 内置 /stats 按 UTC 切日；为保证本机自然日、周、月准确，读取同一工具的会话 token 记录',
  });
}

async function scanClaudeSessions(now = Date.now(), claudeDir = CLAUDE_DIR) {
  if (!fs.existsSync(claudeDir)) return emptyResult(now);

  const cutoff = oldestNeededTimestamp(now);
  const dailyMap = {};
  const allMessages = [];
  const messagesById = new Map();

  // 递归收集 *.jsonl：Claude Code 的会话文件在 projects/<项目>/<sessionId>/ 子目录
  // （以及 memory/、subagents/），只扫第一层会漏掉绝大多数文件
  const jsonlFiles = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // Dirent.isDirectory() 不跟随符号链接，因此可以安全递归到底；Claude 的
      // projects/<project>/<session>/subagents/... 实机会超过 4 层。
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) jsonlFiles.push(p);
    }
  })(claudeDir);

  for (const filePath of jsonlFiles) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) continue;
    } catch { continue; }
    await parseClaudeJsonl(filePath, messagesById);
  }

  for (const message of messagesById.values()) {
    addDailyUsage(dailyMap, message);
    allMessages.push(message);
  }

  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  return buildResult(dailyMap, allMessages, now);
}

// 本地日期（YYYY-MM-DD，按用户时区切日；此前用 UTC 切片导致"今日"边界差 8 小时）
function localDate(input) {
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodStartDates(now = Date.now()) {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mondayOffset = (dayStart.getDay() + 6) % 7;
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - mondayOffset);
  const monthStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), 1);

  return {
    today: localDate(dayStart),
    weekStart: localDate(weekStart),
    monthStart: localDate(monthStart),
  };
}

function oldestNeededTimestamp(now = Date.now()) {
  const d = new Date(now);
  const { weekStart, monthStart } = periodStartDates(now);
  const trendStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 13).getTime();
  return Math.min(new Date(`${weekStart}T00:00:00`).getTime(), new Date(`${monthStart}T00:00:00`).getTime(), trendStart);
}

function createDailyEntry(date, model) {
  return {
    date,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalTokens: 0,
    weightedTokens: 0,
    costUSD: 0,
  };
}

function addDailyUsage(dailyMap, usage) {
  if (!usage.date) return;
  const model = usage.model || 'unknown';
  const key = `${usage.date}|${model}`;
  if (!dailyMap[key]) dailyMap[key] = createDailyEntry(usage.date, model);
  const entry = dailyMap[key];
  entry.requests += usage.requests == null ? 1 : (Number(usage.requests) || 0);
  for (const field of ['inputTokens', 'outputTokens', 'cacheRead', 'cacheCreate', 'totalTokens', 'weightedTokens', 'costUSD']) {
    entry[field] += Number(usage[field]) || 0;
  }
}

function claudeUsageSize(message) {
  return (message.inputTokens || 0) + (message.outputTokens || 0)
    + (message.cacheRead || 0) + (message.cacheCreate || 0);
}

function chooseLatestClaudeMessage(existing, candidate) {
  if (!existing) return candidate;
  if (candidate.timestamp > existing.timestamp) return candidate;
  if (candidate.timestamp < existing.timestamp) return existing;
  return claudeUsageSize(candidate) >= claudeUsageSize(existing) ? candidate : existing;
}

function parseClaudeJsonl(filePath, messagesById) {
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

        // Claude 会用相同 message.id 逐步补全 usage；不能“见过就丢”，要保留最后完整版本。
        // resume/fork 复制的历史消息也会复用同一 id，因此同一逻辑同时完成跨文件去重。
        const dedupKey = obj.message.id
          || obj.uuid
          || `${ts}|${model}|${inputTokens}|${outputTokens}|${cacheRead}|${cacheCreate}`;

        const date = localDate(ts);
        const message = {
          date,
          model,
          timestamp: new Date(ts).getTime(),
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreate,
          totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
          weightedTokens: weightedTokens(inputTokens, outputTokens, cacheRead, cacheCreate),
          costUSD: calcCost(model, inputTokens, outputTokens, cacheRead, cacheCreate),
        };
        // 会话分析沿用计费等效口径，避免长上下文缓存读取把燃烧速度夸大数倍。
        message.sessionTokens = message.weightedTokens;
        messagesById.set(dedupKey, chooseLatestClaudeMessage(messagesById.get(dedupKey), message));
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
    windowTokens += msg.sessionTokens ?? msg.weightedTokens ?? msg.totalTokens;
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

// ── Codex rollout JSONL ───────────────────────────────

function normalizeIncludedCacheUsage({ inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, totalTokens = null }) {
  // Codex/ZCode 的 input 已包含 cacheRead/cacheCreate；缓存只是 input 的分项，不能再加一次。
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreate);
  return {
    inputTokens: uncachedInput,
    outputTokens,
    cacheRead,
    cacheCreate,
    totalTokens: totalTokens == null ? inputTokens + outputTokens : totalTokens,
    weightedTokens: weightedTokens(uncachedInput, outputTokens, cacheRead, cacheCreate),
  };
}

function normalizeCodexTokenEvent(usage = {}) {
  return normalizeIncludedCacheUsage({
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheRead: Number(usage.cached_input_tokens) || 0,
    cacheCreate: Number(usage.cache_write_input_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || null,
  });
}

function codexTotalStateKey(info = {}) {
  const usage = info.total_token_usage;
  if (!usage) return null;
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens,
  ].map(value => Number(value) || 0).join('|');
}

function codexUsageVector(usage = {}) {
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens,
  ].map(value => Number(value) || 0).join('|');
}

function codexUsageEventKey(info = {}) {
  const total = codexTotalStateKey(info);
  if (!total || !info.last_token_usage) return null;
  // fork 会重写顶层 timestamp，因此去重键只能使用两组 usage 状态，不能带时间。
  return `${total}|${codexUsageVector(info.last_token_usage)}`;
}

function codexParentThreadId(source) {
  if (!source) return null;
  try {
    const parsed = typeof source === 'string' ? JSON.parse(source) : source;
    return parsed?.subagent?.thread_spawn?.parent_thread_id || null;
  } catch {
    return null;
  }
}

function codexLineageRoot(threadId, parentById) {
  if (!threadId) return null;
  const seen = new Set();
  let current = threadId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = parentById.get(current);
    if (!parent) break;
    current = parent;
  }
  return current;
}

async function parseCodexRollout(filePath) {
  const events = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.includes('"token_count"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'event_msg' || obj.payload?.type !== 'token_count') continue;
        const info = obj.payload?.info;
        const usage = info?.last_token_usage;
        const date = localDate(obj.timestamp);
        if (!usage || !date) continue;
        const state = codexTotalStateKey(info);
        if (!state) continue;
        const signature = codexUsageEventKey(info);
        if (!signature) continue;
        events.push({
          signature: crypto.createHash('sha1').update(signature).digest('hex'),
          date,
          timestamp: new Date(obj.timestamp).getTime(),
          ...normalizeCodexTokenEvent(usage),
        });
      } catch {}
    }
  } catch {}

  return events;
}

function dedupeCodexEvents(sources, oldestDate) {
  const unique = new Map();
  sources.forEach((source, sourceIndex) => {
    // token_count 没有事件 ID。只有同一父子任务谱系中的 rollout 才可能是
    // fork/subagent 复制；不同独立任务即使 token 数字碰巧相同，也必须分别保留。
    const lineage = source.lineageId || source.threadId || source.filePath || `source:${sourceIndex}`;
    for (const event of source.events || []) {
      const candidate = { ...event, model: source.model || 'codex' };
      const key = `${lineage}|${event.signature}`;
      const existing = unique.get(key);
      // fork 副本可能被重写到另一天；用最早时间还原原事件的归属日。
      if (!existing || candidate.timestamp < existing.timestamp) unique.set(key, candidate);
    }
  });
  return [...unique.values()].filter(event => event.date >= oldestDate);
}

async function scanCodexUsage(now = Date.now()) {
  const source = { kind: 'tool-records', label: 'Codex 自带 token_count 记录' };
  if (!fs.existsSync(CODEX_DB) || !fs.existsSync(CODEX_SESSIONS_DIR)) return emptyResult(now, { ...source, status: 'unavailable' });

  const dailyMap = {};
  try {
    const oldestTs = oldestNeededTimestamp(now);
    const oldestDate = localDate(oldestTs);
    const sql = `SELECT id, source, COALESCE(model, 'codex') AS model, rollout_path
      FROM threads
      WHERE tokens_used > 0`;
    const raw = execFileSync('sqlite3', [CODEX_DB, '-json', sql], { encoding: 'utf8', timeout: 5000 });
    const rows = JSON.parse(raw || '[]');
    const parentById = new Map(rows.map(row => [row.id, codexParentThreadId(row.source)]));
    const activePaths = new Set();
    const sources = [];

    for (const row of rows) {
      const filePath = row.rollout_path;
      if (!filePath || activePaths.has(filePath) || !fs.existsSync(filePath)) continue;
      activePaths.add(filePath);

      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      let cachedFile = codexRolloutCache.get(filePath);
      if (!cachedFile || cachedFile.size !== stat.size || cachedFile.mtimeMs !== stat.mtimeMs) {
        cachedFile = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          events: await parseCodexRollout(filePath),
        };
        codexRolloutCache.set(filePath, cachedFile);
      }
      sources.push({
        threadId: row.id,
        lineageId: codexLineageRoot(row.id, parentById),
        filePath,
        model: row.model || 'codex',
        events: cachedFile.events,
      });
    }

    for (const filePath of codexRolloutCache.keys()) {
      if (!activePaths.has(filePath)) codexRolloutCache.delete(filePath);
    }
    for (const event of dedupeCodexEvents(sources, oldestDate)) addDailyUsage(dailyMap, event);
  } catch {
    return emptyResult(now, { ...source, status: 'error' });
  }

  return attachSource(buildResult(dailyMap, [], now), source);
}

// ── OpenCode SQLite ──────────────────────────────────────

async function scanOpenCodeUsage(now = Date.now(), dbPath = OPENCODE_DB) {
  const source = { kind: 'built-in', label: 'OpenCode stats 数据库' };
  if (!fs.existsSync(dbPath)) return emptyResult(now, { ...source, status: 'unavailable' });

  const dailyMap = {};
  try {
    // message.data 是逐次响应；不能读 session 的累计值后按创建日归桶，否则长会话会错日。
    const sql = `SELECT
        COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.id'), 'unknown') AS model,
        COALESCE(json_extract(data, '$.cost'), 0) AS cost,
        COALESCE(json_extract(data, '$.tokens.input'), 0) AS tokens_input,
        COALESCE(json_extract(data, '$.tokens.output'), 0) AS tokens_output,
        COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS tokens_reasoning,
        COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS tokens_cache_read,
        COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS tokens_cache_write,
        time_created
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'`;
    const raw = execFileSync('sqlite3', [dbPath, '-json', sql], { encoding: 'utf8', timeout: 5000 });
    const rows = JSON.parse(raw || '[]');

    for (const row of rows) {
      const modelName = row.model || 'unknown';
      const cost = parseFloat(row.cost) || 0;
      const date = localDate(row.time_created);
      const inputTokens = Number(row.tokens_input) || 0;
      const outputTokens = Number(row.tokens_output) || 0;
      const reasoningTokens = Number(row.tokens_reasoning) || 0;
      const cacheRead = Number(row.tokens_cache_read) || 0;
      const cacheCreate = Number(row.tokens_cache_write) || 0;
      // OpenCode 的 tokens.input 不包含 cache.read/cache.write；reasoning 也是独立分项。
      // 它和 Codex/ZCode 的字段语义不同，不能复用“缓存已含在 input”的归一化函数。
      const combinedOutput = outputTokens + reasoningTokens;
      addDailyUsage(dailyMap, {
        date,
        model: modelName,
        inputTokens,
        outputTokens: combinedOutput,
        cacheRead,
        cacheCreate,
        totalTokens: inputTokens + combinedOutput + cacheRead + cacheCreate,
        weightedTokens: weightedTokens(inputTokens, combinedOutput, cacheRead, cacheCreate),
        costUSD: cost,
      });
    }
  } catch {
    return emptyResult(now, { ...source, status: 'error' });
  }

  return attachSource(buildResult(dailyMap, [], now), source);
}

// ── Helpers ──────────────────────────────────────

function emptyResult(now = Date.now(), source = null) {
  const result = buildResult({}, [], now);
  return source ? attachSource(result, source) : result;
}

// ── ZCode CLI（model_usage 表：含完整缓存分项，可等效折算） ──
async function scanZcodeUsage(now = Date.now(), dbPath = ZCODE_DB) {
  const source = { kind: 'built-in', label: 'ZCode 自带 model_usage 统计' };
  if (!fs.existsSync(dbPath)) return emptyResult(now, { ...source, status: 'unavailable' });

  const dailyMap = {};
  try {
    const sql = `SELECT started_at, model_id, input_tokens, output_tokens, reasoning_tokens,
        cache_read_input_tokens, cache_creation_input_tokens,
        provider_total_tokens, computed_total_tokens
      FROM model_usage
      WHERE started_at >= ${oldestNeededTimestamp(now)}
        AND (provider_total_tokens > 0 OR computed_total_tokens > 0 OR input_tokens > 0 OR output_tokens > 0)`;
    const raw = execFileSync('sqlite3', [dbPath, '-json', sql], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    });
    const rows = JSON.parse(raw || '[]');

    for (const row of rows) {
      const inputTokens = Number(row.input_tokens) || 0;
      const outputTokens = (Number(row.output_tokens) || 0) + (Number(row.reasoning_tokens) || 0);
      const cacheRead = Number(row.cache_read_input_tokens) || 0;
      const cacheCreate = Number(row.cache_creation_input_tokens) || 0;
      const totalTokens = Number(row.provider_total_tokens)
        || Number(row.computed_total_tokens)
        || inputTokens + outputTokens;
      if (totalTokens <= 0) continue;
      const modelName = row.model_id || 'unknown';
      const date = localDate(row.started_at); // ms
      const normalized = normalizeIncludedCacheUsage({
        inputTokens,
        outputTokens,
        cacheRead,
        cacheCreate,
        totalTokens,
      });
      addDailyUsage(dailyMap, { date, model: modelName, ...normalized });
    }
  } catch {
    return emptyResult(now, { ...source, status: 'error' });
  }

  return attachSource(buildResult(dailyMap, [], now), source);
}

function buildResult(dailyMap, allMessages = [], now = Date.now()) {
  const entries = Object.values(dailyMap);

  for (const e of entries) {
    if (e.costUSD === 0) {
      e.costUSD = calcCost(e.model, e.inputTokens || 0, e.outputTokens || 0, e.cacheRead || 0, e.cacheCreate || 0);
    }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  // 今日/本周/本月按本地时区切日（与 daily 桶一致）
  const { today, weekStart, monthStart } = periodStartDates(now);

  const summary = {
    todayTokens: 0,
    weekTokens: 0,
    monthTokens: 0,
    todayNonCachedTokens: 0,
    weekNonCachedTokens: 0,
    monthNonCachedTokens: 0,
    todayCacheReadTokens: 0,
    weekCacheReadTokens: 0,
    monthCacheReadTokens: 0,
    todayRequests: 0,
    weekRequests: 0,
    monthRequests: 0,
    todayCost: 0,
    weekCost: 0,
    monthCost: 0,
    byModel: {},
    tokenBasis: 'actual',
    periods: {
      today: { start: today, end: today },
      week: { start: weekStart, end: today },
      month: { start: monthStart, end: today },
    },
  };

  for (const e of entries) {
    // 主口径 = 实际 token。缓存字段在不同工具里可能是 input 的子集，采集阶段已按来源归一化。
    const tokens = e.totalTokens != null
      ? e.totalTokens
      : ((e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheRead || 0) + (e.cacheCreate || 0));
    const inCurrentTime = e.date <= today;
    const cacheReadTokens = e.cacheRead || 0;
    // 四个来源都满足：总处理量 = 非缓存 + 缓存读取。旧记录若只有总数、没有缓存分项，
    // 无法再还原缓存占比，只能保守归到非缓存；不能因为同日还有新格式记录就把它漏掉。
    const nonCachedTokens = Math.max(0, tokens - cacheReadTokens);
    const requests = e.requests || 0;

    if (e.model && e.model !== 'unknown') {
      if (!summary.byModel[e.model]) summary.byModel[e.model] = { today: 0, week: 0, month: 0, total: 0, cost: 0 };
      if (e.date === today) summary.byModel[e.model].today += tokens;
      if (inCurrentTime && e.date >= weekStart) summary.byModel[e.model].week += tokens;
      if (inCurrentTime && e.date >= monthStart) summary.byModel[e.model].month += tokens;
      summary.byModel[e.model].total += tokens;
      summary.byModel[e.model].cost += e.costUSD;
    }

    if (inCurrentTime && e.date >= monthStart) {
      summary.monthTokens += tokens;
      summary.monthNonCachedTokens += nonCachedTokens;
      summary.monthCacheReadTokens += cacheReadTokens;
      summary.monthRequests += requests;
      summary.monthCost += e.costUSD;
    }
    if (inCurrentTime && e.date >= weekStart) {
      summary.weekTokens += tokens;
      summary.weekNonCachedTokens += nonCachedTokens;
      summary.weekCacheReadTokens += cacheReadTokens;
      summary.weekRequests += requests;
      summary.weekCost += e.costUSD;
    }
    if (e.date === today) {
      summary.todayTokens += tokens;
      summary.todayNonCachedTokens += nonCachedTokens;
      summary.todayCacheReadTokens += cacheReadTokens;
      summary.todayRequests += requests;
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

module.exports = {
  createLocalUsageService,
  scanClaudeUsage,
  buildResult,
  periodStartDates,
  normalizeIncludedCacheUsage,
  normalizeCodexTokenEvent,
  codexTotalStateKey,
  codexUsageEventKey,
  codexParentThreadId,
  codexLineageRoot,
  dedupeCodexEvents,
  chooseLatestClaudeMessage,
  parseCodexRollout,
  scanClaudeSessions,
  scanOpenCodeUsage,
  scanZcodeUsage,
};
