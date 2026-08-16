// 统一“剩余”语义：所有进度一律展示“还剩多少”。
// quota 字段来自各 provider：used/total（用量型）或 balance/total（余额型）。
// 前端（popover.html）与 Swift（main.swift）各自镜像同一套规则，改这里时需同步。

function quotaRemaining(q) {
  if (!q) return null;
  if (q.total > 0 && q.used != null) {
    const pct = Math.round((1 - q.used / q.total) * 100);
    return { kind: 'percent', remainingPct: Math.max(0, Math.min(100, pct)) };
  }
  if (q.balance != null && q.total > 0) {
    const pct = Math.round((q.balance / q.total) * 100);
    return { kind: 'percent', remainingPct: Math.max(0, Math.min(100, pct)) };
  }
  if (q.balance != null) {
    return { kind: 'balance', balance: q.balance, unit: q.unit || '' };
  }
  return null;
}

function minRemainingPct(quotas) {
  let min = null;
  for (const q of quotas || []) {
    const r = quotaRemaining(q);
    if (r && r.kind === 'percent' && (min === null || r.remainingPct < min)) {
      min = r.remainingPct;
    }
  }
  return min;
}

module.exports = { quotaRemaining, minRemainingPct };
