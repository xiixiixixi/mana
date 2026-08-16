// 计费等效 tokens：与 Claude 额度扣减一致的权重（缓存读 0.1×、缓存写 1.25×）。
// 原始总和（input+output+cacheRead+cacheCreate）会把每轮重复读取的上下文全部计入，
// 重缓存场景一天可虚高数倍（实测 51M 原始 ≈ 7M 等效），作为"消耗"展示具有误导性。
// localUsage.js（daily/summary/会话分析）与 popover LOCAL 卡共用此口径。
function weightedTokens(inputTokens, outputTokens, cacheRead, cacheCreate) {
  return (inputTokens || 0) + (outputTokens || 0) + (cacheRead || 0) * 0.1 + (cacheCreate || 0) * 1.25;
}

module.exports = { weightedTokens };
