const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  buildResult,
  periodStartDates,
  normalizeIncludedCacheUsage,
  normalizeCodexTokenEvent,
  codexTotalStateKey,
  chooseLatestClaudeMessage,
  parseCodexRollout,
  dedupeCodexEvents,
  codexParentThreadId,
  codexLineageRoot,
  scanClaudeUsage,
  scanClaudeSessions,
  scanOpenCodeUsage,
  scanZcodeUsage,
} = require('../src/server/services/localUsage');

function localTime(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0).getTime();
}

test('自然周期使用本地自然日、周一和每月一号作为起点', () => {
  assert.deepEqual(periodStartDates(localTime(2026, 8, 26)), {
    today: '2026-08-26',
    weekStart: '2026-08-24',
    monthStart: '2026-08-01',
  });

  // 周可以跨月，但月仍从当月 1 日开始。
  assert.deepEqual(periodStartDates(localTime(2026, 8, 2)), {
    today: '2026-08-02',
    weekStart: '2026-07-27',
    monthStart: '2026-08-01',
  });
});

test('Claude Code 按本地时间切日，东八区凌晨不会被归到 UTC 前一天', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-claude-local-day-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'projects');
  await fs.mkdir(sessionsDir, { recursive: true });
  const record = (id, timestamp, input, output) => JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { id, model: 'modelA', usage: { input_tokens: input, output_tokens: output } },
  });
  await fs.writeFile(path.join(sessionsDir, 'session.jsonl'), [
    record('before-midnight', '2026-08-26T23:30:00+08:00', 8, 2),
    record('after-midnight', '2026-08-27T00:30:00+08:00', 20, 5),
  ].join('\n'));

  const result = await scanClaudeUsage(localTime(2026, 8, 27), sessionsDir);
  assert.equal(result.summary.todayTokens, 25);
  assert.equal(result.summary.weekTokens, 35);
  assert.equal(result.summary.monthTokens, 35);
  assert.equal(result.source.kind, 'tool-records');
});

test('今日、本周、本月是固定日历窗口，不是近 7 天和近 30 天', () => {
  const dailyMap = {
    oldMonth: { date: '2026-07-31', model: 'm', totalTokens: 1, costUSD: 0 },
    monthStart: { date: '2026-08-01', model: 'm', totalTokens: 2, costUSD: 0 },
    sunday: { date: '2026-08-23', model: 'm', totalTokens: 4, costUSD: 0 },
    monday: { date: '2026-08-24', model: 'm', totalTokens: 8, costUSD: 0 },
    today: { date: '2026-08-26', model: 'm', totalTokens: 16, costUSD: 0 },
    future: { date: '2026-08-27', model: 'm', totalTokens: 32, costUSD: 0 },
  };

  const result = buildResult(dailyMap, [], localTime(2026, 8, 26));
  assert.equal(result.summary.todayTokens, 16);
  assert.equal(result.summary.weekTokens, 24);
  assert.equal(result.summary.monthTokens, 30);
  assert.equal(result.summary.todayNonCachedTokens, 16);
  assert.equal(result.summary.weekNonCachedTokens, 24);
  assert.equal(result.summary.monthNonCachedTokens, 30);
  assert.deepEqual(result.summary.periods, {
    today: { start: '2026-08-26', end: '2026-08-26' },
    week: { start: '2026-08-24', end: '2026-08-26' },
    month: { start: '2026-08-01', end: '2026-08-26' },
  });
});

test('同一天同模型混合完整分项和只有总数的记录时不会漏掉总数', () => {
  const dailyMap = {};
  const date = '2026-08-26';
  const model = 'codex';
  dailyMap[`${date}|${model}`] = {
    date,
    model,
    requests: 2,
    inputTokens: 20,
    outputTokens: 10,
    cacheRead: 80,
    cacheCreate: 0,
    totalTokens: 233,
    weightedTokens: 0,
    costUSD: 0,
  };

  const result = buildResult(dailyMap, [], localTime(2026, 8, 26));
  assert.equal(result.summary.todayTokens, 233);
  assert.equal(result.summary.todayCacheReadTokens, 80);
  assert.equal(result.summary.todayNonCachedTokens, 153);
  assert.equal(
    result.summary.todayNonCachedTokens + result.summary.todayCacheReadTokens,
    result.summary.todayTokens,
  );
});

test('缓存已包含在 input 时不会再次计入实际 token', () => {
  const normalized = normalizeIncludedCacheUsage({
    inputTokens: 404727,
    outputTokens: 667,
    cacheRead: 404416,
    cacheCreate: 0,
  });

  assert.equal(normalized.totalTokens, 405394);
  assert.ok(Math.abs(normalized.weightedTokens - 41419.6) < 1e-6);
});

test('Codex token_count 使用单次增量并识别缓存是 input 的子集', () => {
  const normalized = normalizeCodexTokenEvent({
    input_tokens: 63725,
    cached_input_tokens: 60672,
    output_tokens: 66,
    reasoning_output_tokens: 0,
    total_tokens: 63791,
  });

  assert.deepEqual(normalized, {
    inputTokens: 3053,
    outputTokens: 66,
    cacheRead: 60672,
    cacheCreate: 0,
    totalTokens: 63791,
    weightedTokens: 9186.2,
  });
});

test('Codex cache write 也是 input 子集且进入语义去重状态', () => {
  const normalized = normalizeCodexTokenEvent({
    input_tokens: 1000,
    cached_input_tokens: 600,
    cache_write_input_tokens: 100,
    output_tokens: 50,
    total_tokens: 1050,
  });
  assert.equal(normalized.inputTokens, 300);
  assert.equal(normalized.cacheCreate, 100);
  assert.equal(normalized.totalTokens, 1050);
});

test('Codex 同一累计状态即使刷新时间不同也只应计一次', () => {
  const info = {
    total_token_usage: {
      input_tokens: 1000,
      cached_input_tokens: 800,
      output_tokens: 50,
      reasoning_output_tokens: 10,
      total_tokens: 1050,
    },
  };
  assert.equal(codexTotalStateKey(info), '1000|800|0|50|10|1050');
  assert.equal(codexTotalStateKey({ ...info, model_context_window: 999999 }), '1000|800|0|50|10|1050');
});

test('Claude 流式更新使用同 message id 的最后完整记录', () => {
  const first = { timestamp: 1000, inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheCreate: 0 };
  const later = { timestamp: 2000, inputTokens: 100, outputTokens: 40, cacheRead: 0, cacheCreate: 0 };
  assert.equal(chooseLatestClaudeMessage(first, later), later);

  // 时间相同的复制记录，选择 token 更完整的一条。
  const fuller = { ...later, timestamp: 2000, outputTokens: 60 };
  assert.equal(chooseLatestClaudeMessage(later, fuller), fuller);
});

test('Codex rollout 对累计状态重复广播只计一次', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-codex-rollout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const event = (timestamp, total, last) => JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: last - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: last,
        },
      },
    },
  });
  await fs.writeFile(file, [
    event('2026-08-26T01:00:00.000Z', 100, 100),
    event('2026-08-26T01:01:00.000Z', 100, 100),
    event('2026-08-26T01:02:00.000Z', 200, 100),
    event('2026-08-26T01:03:00.000Z', 100, 100),
  ].join('\n'));

  const events = await parseCodexRollout(file);
  assert.equal(events.length, 4);
  const unique = dedupeCodexEvents([{ model: 'codex', events }], '2026-08-01');
  assert.equal(unique.length, 2);
  assert.equal(unique.reduce((sum, item) => sum + item.totalTokens, 0), 200);
});

test('Codex fork 改写时间戳后仍按 usage 语义去重并归到最早日期', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-codex-fork-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const makeEvent = timestamp => JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 90, cached_input_tokens: 40, output_tokens: 10, total_tokens: 100 },
        last_token_usage: { input_tokens: 90, cached_input_tokens: 40, output_tokens: 10, total_tokens: 100 },
      },
    },
  });
  const original = path.join(dir, 'original.jsonl');
  const fork = path.join(dir, 'fork.jsonl');
  await fs.writeFile(original, makeEvent('2026-08-01T01:00:00.000Z'));
  await fs.writeFile(fork, makeEvent('2026-08-26T01:00:00.000Z'));

  const unique = dedupeCodexEvents([
    { lineageId: 'root-a', model: 'codex', events: await parseCodexRollout(fork) },
    { lineageId: 'root-a', model: 'codex', events: await parseCodexRollout(original) },
  ], '2026-08-01');
  assert.equal(unique.length, 1);
  assert.equal(unique[0].date, '2026-08-01');
  assert.equal(unique[0].totalTokens, 100);
});

test('Codex 两个独立任务即使 token 向量相同也都保留', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-codex-independent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const line = JSON.stringify({
    timestamp: '2026-08-26T01:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
        last_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
      },
    },
  });
  const first = path.join(dir, 'first.jsonl');
  const second = path.join(dir, 'second.jsonl');
  await Promise.all([fs.writeFile(first, line), fs.writeFile(second, line)]);

  const unique = dedupeCodexEvents([
    { lineageId: 'root-a', events: await parseCodexRollout(first) },
    { lineageId: 'root-b', events: await parseCodexRollout(second) },
  ], '2026-08-01');
  assert.equal(unique.length, 2);
  assert.equal(unique.reduce((sum, item) => sum + item.totalTokens, 0), 200);
});

test('Codex 只把显式父子任务归入同一谱系', () => {
  const parentSource = JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: 'root-a' } },
  });
  assert.equal(codexParentThreadId(parentSource), 'root-a');
  assert.equal(codexParentThreadId('vscode'), null);

  const parents = new Map([
    ['child-b', 'child-a'],
    ['child-a', 'root-a'],
    ['root-a', null],
  ]);
  assert.equal(codexLineageRoot('child-b', parents), 'root-a');
  assert.equal(codexLineageRoot('independent', parents), 'independent');
});

test('ZCode 使用官方总数，且不会丢掉只有总数的记录', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-zcode-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'db.sqlite');
  execFileSync('sqlite3', [db, `
    CREATE TABLE model_usage (
      started_at INTEGER, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      provider_total_tokens INTEGER, computed_total_tokens INTEGER
    );
    INSERT INTO model_usage VALUES (${localTime(2026, 8, 26)}, 'total-only', 0, 0, 0, 0, 0, 123, 0);
    INSERT INTO model_usage VALUES (${localTime(2026, 8, 26)}, 'cached', 100, 10, 0, 80, 0, 110, 190);
    INSERT INTO model_usage VALUES (${localTime(2026, 8, 26)}, 'reasoning', 100, 10, 5, 80, 0, NULL, 115);
    INSERT INTO model_usage VALUES (${localTime(2026, 8, 26)}, 'zero', 0, 0, 0, 0, 0, 0, 0);
  `]);

  const result = await scanZcodeUsage(localTime(2026, 8, 26), db);
  assert.equal(result.summary.todayTokens, 348);
  assert.equal(result.summary.todayNonCachedTokens, 188);
  assert.equal(result.summary.todayCacheReadTokens, 160);
  assert.equal(result.summary.todayRequests, 3);
  assert.equal(result.summary.byModel['total-only'].today, 123);
  assert.equal(result.summary.byModel.cached.today, 110);
  assert.equal(result.summary.byModel.reasoning.today, 115);
  assert.equal(result.summary.byModel.zero, undefined);
});

test('OpenCode 按 assistant 消息发生日统计，不使用会话累计值', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-opencode-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'opencode.db');
  const first = JSON.stringify({ role: 'assistant', modelID: 'm', tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 80, write: 0 } } });
  const second = JSON.stringify({ role: 'assistant', modelID: 'm', tokens: { input: 200, output: 20, reasoning: 10, cache: { read: 150, write: 5 } } });
  execFileSync('sqlite3', [db, `
    CREATE TABLE message (data TEXT, time_created INTEGER);
    INSERT INTO message VALUES ('${first.replaceAll("'", "''")}', ${localTime(2026, 8, 25)});
    INSERT INTO message VALUES ('${second.replaceAll("'", "''")}', ${localTime(2026, 8, 26)});
  `]);

  const result = await scanOpenCodeUsage(localTime(2026, 8, 26), db);
  assert.equal(result.summary.todayTokens, 385);
  assert.equal(result.summary.weekTokens, 580);
  assert.equal(result.summary.todayNonCachedTokens, 235);
  assert.equal(result.summary.weekNonCachedTokens, 350);
  assert.equal(result.summary.todayCacheReadTokens, 150);
  assert.equal(result.summary.weekCacheReadTokens, 230);
  assert.equal(result.summary.weekRequests, 2);
});

test('Claude 递归扫描嵌套目录，并保留同 message id 的最后完整 usage', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-claude-tree-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'project', 'session', 'subagents', 'deep', 'leaf');
  await fs.mkdir(nested, { recursive: true });
  const record = (timestamp, output) => JSON.stringify({
    timestamp,
    type: 'assistant',
    message: {
      id: 'msg-same',
      model: 'claude-test',
      usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  await fs.writeFile(path.join(dir, 'project', 'old.jsonl'), record('2026-08-26T01:00:00.000Z', 10));
  await fs.writeFile(path.join(nested, 'new.jsonl'), record('2026-08-26T02:00:00.000Z', 40));

  const result = await scanClaudeSessions(localTime(2026, 8, 26), dir);
  assert.equal(result.daily.length, 1);
  assert.equal(result.summary.todayTokens, 140);
});
