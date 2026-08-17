#!/usr/bin/env node
// mana CLI — 读取本机 Mana 服务的用量数据（macOS app 运行时可用）
// 用法:
//   mana usage [--json] [--provider <id>]   全平台用量（默认按剩余%升序）
//   mana summary [--json]                   单行摘要：最低剩余 + 平台数
//   mana local [--days 7] [--json]          本地 CLI 用量（Claude Code/Codex/OpenCode）
const BASE = 'http://127.0.0.1:41119';

const args = process.argv.slice(2);
const cmd = args[0] || 'usage';
const json = args.includes('--json');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 7 : 7;
const provIdx = args.indexOf('--provider');
const provider = provIdx >= 0 ? args[provIdx + 1] : null;

function die(msg) {
  console.error(`mana: ${msg}`);
  console.error('app 未运行？先启动 Mana.app（菜单栏），服务在 127.0.0.1:41119。');
  process.exit(2);
}

async function get(path) {
  try {
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
    // 主口径：可折算等效的源（claude + opencode）；codex 为平台原始口径，单列
    const w = { today: 0, week: 0, month: 0 };
    for (const src of [j.zcode, j.claude, j.opencode]) {
      if (src && src.summary) { w.today += src.summary.todayTokens || 0; w.week += src.summary.weekTokens || 0; w.month += src.summary.monthTokens || 0; }
    }
    console.log(`local usage (billing-equivalent, last 30d)`);
    console.log(`  today  ${Math.round(w.today)}`);
    console.log(`  week   ${Math.round(w.week)}`);
    console.log(`  month  ${Math.round(w.month)}`);
    if (j.codex && j.codex.summary && j.codex.summary.monthTokens > 0) {
      console.log(`  codex  ${Math.round(j.codex.summary.monthTokens)} raw tokens this month (platform metric, not comparable)`);
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
    console.log(`${pad(r.name, nameW)}  ${pad(r.track, trW)}  ${val}  ↻${r.reset}`);
  }
  if (!rows.length) console.log('(no data — check keys in Mana settings)');
})();
