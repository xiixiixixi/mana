const test = require('node:test');
const assert = require('node:assert');
const { quotaRemaining, minRemainingPct } = require('../src/server/services/remaining');

test('用量型 quota：剩余 = 100 - used/total', () => {
  assert.deepStrictEqual(quotaRemaining({ used: 62, total: 100 }), { kind: 'percent', remainingPct: 38 });
  assert.deepStrictEqual(quotaRemaining({ used: 5, total: 100 }), { kind: 'percent', remainingPct: 95 });
});

test('余额型 quota（有总额）：剩余 = balance/total', () => {
  assert.deepStrictEqual(quotaRemaining({ balance: 30, total: 100, unit: '$' }), { kind: 'percent', remainingPct: 30 });
});

test('余额型 quota（无总额）：返回绝对余额', () => {
  assert.deepStrictEqual(quotaRemaining({ balance: 12.5, total: 0, unit: '¥' }), { kind: 'balance', balance: 12.5, unit: '¥' });
});

test('边界：超界值被夹在 0-100', () => {
  assert.strictEqual(quotaRemaining({ used: 120, total: 100 }).remainingPct, 0);
  assert.strictEqual(quotaRemaining({ balance: 300, total: 100 }).remainingPct, 100);
});

test('minRemainingPct 取多轨最低值，忽略余额型与空值', () => {
  assert.strictEqual(minRemainingPct([
    { used: 62, total: 100 },
    { used: 77, total: 100 },
    { balance: 9.9, total: 0, unit: '¥' },
  ]), 23);
  assert.strictEqual(minRemainingPct([]), null);
  assert.strictEqual(minRemainingPct([{ balance: 5, total: 0 }]), null);
});
