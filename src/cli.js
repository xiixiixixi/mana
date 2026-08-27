#!/usr/bin/env node
// mana CLI — 读取本机 Mana 服务的用量数据（macOS app 运行时可用）
// 用法:
//   mana usage [--json] [--provider <id>]   全平台用量（默认按剩余%升序）
//   mana summary [--json]                   单行摘要：最低剩余 + 平台数
//   mana local [--json]                     本地 Agent 用量（固定今日/自然周/自然月）
// 端口发现：优先读端口文件（41119 被占时 Node 会回退并写入），否则扫描 41119-41128
const os = require('os');
const fs = require('fs');
const path = require('path');
function resolveBase() {
  try {
    const p = parseInt(fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'mana', 'port'), 'utf8').trim());
    if (p >= 41119 && p <= 41140) return `http://127.0.0.1:${p}`;
  } catch {}
  return null;
}
let BASE = null;

const args = process.argv.slice(2);
const cmd = args[0] || 'usage';
const json = args.includes('--json');
const provIdx = args.indexOf('--provider');
const provider = provIdx >= 0 ? args[provIdx + 1] : null;

function die(msg) {
  console.error(`mana: ${msg}`);
  console.error('app 未运行？先启动 Mana.app（菜单栏），服务在 127.0.0.1:41119 起。');
  process.exit(2);
}

async function get(path) {
  try {
    if (!BASE) {
      BASE = resolveBase();
      if (!BASE) {
        // 端口文件没有（老版本 app 或未运行），快速探测端口段
        for (let p = 41119; p <= 41128 && !BASE; p++) {
          try {
            const probe = await fetch(`http://127.0.0.1:${p}/api/providers`, { signal: AbortSignal.timeout(600) });
            if (probe.ok) BASE = `http://127.0.0.1:${p}`;
          } catch {}
        }
        if (!BASE) BASE = 'http://127.0.0.1:41119';
      }
    }
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    die(e.message);
  }
}

function remaining(q) {
  if (q.total > 0 && q.used != null) return Math.max(0, Math.min(100, Math.round((1 - q.used / q.total) * 100)));
  if (q.balance != null && q.total > 0) return Math.max(0, Math.min(100, Math.round(q.balance / q.total * 100)));
  return null;
}

function bar(pct) {
  if (pct == null) return '          ';
  const n = Math.round(pct / 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

// 显示宽度（CJK 计 2 列），保证终端列对齐
function dispLen(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}
function pad(s, w) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, w - dispLen(s)));
}

(async () => {
  if (cmd === 'summary') {
    const j = await get('/api/summary');
    if (json) return console.log(JSON.stringify(j));
    console.log(`lowest ${j.lowestRemainingPct}% (${j.lowestProvider}) · ${j.providerCount} providers · ${new Date(j.updatedAt).toLocaleTimeString()}`);
    return;
  }

  if (cmd === 'local') {
    const j = await get('/api/local-usage');
    if (json) return console.log(JSON.stringify(j));
    // 固定只统计四个工具自己记录的总 token；不按模型、服务商或 API Key 重新归属。
    const w = { today: 0, week: 0, month: 0 };
    const sources = [['claude-code', j.claude], ['opencode', j.opencode], ['codex', j.codex], ['zcode', j.zcode]];
    const incomplete = sources.some(([, src]) => src?.source?.status === 'error' || src?.source?.status === 'unavailable');
    for (const [, src] of sources) {
      if (src && src.summary) {
        w.today += src.summary.todayTokens || 0;
        w.week += src.summary.weekTokens || 0;
        w.month += src.summary.monthTokens || 0;
      }
    }
    console.log(`四工具总 token（Claude Code / OpenCode / Codex / ZCode）${incomplete ? ' · 当前合计不完整' : ''}`);
    console.log(`  今日  ${Math.round(w.today)}`);
    console.log(`  本周  ${Math.round(w.week)}`);
    console.log(`  本月  ${Math.round(w.month)}`);
    for (const [name, src] of sources) {
      if (src?.summary) {
        const s = src.summary;
        if (src.source?.status === 'error') {
          console.log(`  ${name.padEnd(11)} 读取失败 · 不按 0 计`);
          continue;
        }
        if (src.source?.status === 'unavailable') {
          console.log(`  ${name.padEnd(11)} 未找到数据源 · 不按 0 计`);
          continue;
        }
        console.log(`  ${name.padEnd(11)} 今日 ${Math.round(s.todayTokens || 0)} · 本周 ${Math.round(s.weekTokens || 0)} · 本月 ${Math.round(s.monthTokens || 0)}`);
        console.log(`  ${''.padEnd(11)} 来源：${src.source?.label || '工具本地记录'}`);
      }
    }
    return;
  }

  if (cmd !== 'usage') {
    console.error('unknown command: ' + cmd);
    process.exit(1);
  }

  const j = await get('/api/usage');
  let provs = (j.providers || []).filter(p => p.status !== 'error');
  if (provider) provs = provs.filter(p => p.id === provider);
  if (json) return console.log(JSON.stringify({ providers: provs }, null, 2));

  const rows = [];
  for (const p of provs) {
    for (const q of p.quotas || []) {
      rows.push({ name: p.label ? `${p.name}·${p.label}` : p.name, track: q.label || '-', pct: remaining(q), reset: q.resetIn || '—', balance: q.balance, unlimited: q.unlimited });
    }
  }
  rows.sort((a, b) => (a.pct == null ? 999 : a.pct) - (b.pct == null ? 999 : b.pct));
  const nameW = Math.max(8, ...rows.map(r => dispLen(r.name)));
  const trW = Math.max(6, ...rows.map(r => dispLen(r.track)));
  for (const r of rows) {
    const bal = r.unlimited ? '∞' : (r.balance != null ? `bal ${r.balance}` : '--');
    const val = r.pct != null ? `${bar(r.pct)} ${String(r.pct).padStart(3)}%` : bal.padStart(14);
    console.log(`${pad(r.name, nameW)}  ${pad(r.track, trW)}  ${val}  ${r.reset}`);
  }
  if (!rows.length) console.log('(no data — check keys in Mana settings)');
})();
