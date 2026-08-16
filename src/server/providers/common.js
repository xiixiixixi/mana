// 各 provider 共享的取数/格式化工具，消除重复样板。

// GET 并解析 JSON：统一超时、状态码检查。错误对象带 .status 供调用方按需映射。
async function httpGetJson(url, { headers = {}, timeout = 8000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 相对时长（输入：剩余毫秒）。<=0 返回 null。
function formatDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}天`;
}

// 重置时刻（输入：epoch 毫秒 或 ISO 字符串）。已过期返回 '即将重置'。
function formatResetAt(at) {
  if (!at) return null;
  const ts = typeof at === 'number' ? at : new Date(at).getTime();
  const diff = ts - Date.now();
  if (diff <= 0) return '即将重置';
  return formatDuration(diff);
}

// 构造单一余额型 quota 对象（仅显示余额，不含百分比进度）。
function buildBalanceQuota(label, balance, unit = '¥') {
  return { label, used: 0, total: 0, unit, balance, resetIn: null, window: null };
}

module.exports = { httpGetJson, formatDuration, formatResetAt, buildBalanceQuota };
