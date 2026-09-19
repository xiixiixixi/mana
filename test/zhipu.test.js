const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowLabel } = require('../src/server/providers/zhipu.js');

const HOUR = 3600000;
const inHours = h => Date.now() + h * HOUR;

test('每周额度重置 2 天后（剩余 3.5 天）仍标为每周，不再错标每日', () => {
  // 回归：unit=6 实测为周窗口；旧逻辑按剩余时长分桶，剩 <5 天会掉进"每日额度"
  assert.equal(windowLabel({ unit: 6, nextResetTime: inHours(3.5 * 24) }), '每周额度');
});

test('每周额度刚重置（剩余近 7 天）标为每周', () => {
  assert.equal(windowLabel({ unit: 6, nextResetTime: inHours(6.9 * 24) }), '每周额度');
});

test('月度额度中段（剩余 20 天）标为每月，不再错标每日', () => {
  assert.equal(windowLabel({ unit: 5, nextResetTime: inHours(20 * 24) }), '每月额度');
});

test('unit=3 是 5h 窗口', () => {
  assert.equal(windowLabel({ unit: 3, nextResetTime: inHours(7) }), '5h 窗口');
});

test('unit 缺失时按时长兜底：≤8h → 5h 窗口', () => {
  assert.equal(windowLabel({ nextResetTime: inHours(5) }), '5h 窗口');
});

test('unit 缺失时按时长兜底：≤24h → 每日额度', () => {
  assert.equal(windowLabel({ nextResetTime: inHours(20) }), '每日额度');
});

test('unit 缺失时按时长兜底：24h~25d → 每周额度（周窗口中段）', () => {
  assert.equal(windowLabel({ nextResetTime: inHours(3 * 24) }), '每周额度');
});

test('unit 缺失时按时长兜底：≥25d → 每月额度', () => {
  assert.equal(windowLabel({ nextResetTime: inHours(27 * 24) }), '每月额度');
});

test('未知 unit 走时长兜底', () => {
  assert.equal(windowLabel({ unit: 4, nextResetTime: inHours(10) }), '每日额度');
});

test('无 nextResetTime → Token额度', () => {
  assert.equal(windowLabel({ unit: 6 }), 'Token额度');
});
