const test = require('node:test');
const assert = require('node:assert');
// weightedTokens 未从模块导出（localUsage 是工厂模块），这里直接验证口径约定：
// 计费等效 = input + output + cacheRead×0.1 + cacheCreate×1.25
const { weightedTokens } = require('../src/server/services/weighted');

test('计费等效：缓存读按 0.1 计', () => {
  assert.strictEqual(weightedTokens(0, 0, 49036800, 0), 4903680);
});

test('计费等效：缓存写按 1.25 计', () => {
  assert.strictEqual(weightedTokens(1000, 2000, 0, 4000), 1000 + 2000 + 5000);
});

test('典型重缓存日：51M 原始 ≈ 7M 等效', () => {
  const w = weightedTokens(2169722, 64335, 49036800, 0);
  assert.ok(w > 6.5e6 && w < 8e6, `got ${w}`);
});
