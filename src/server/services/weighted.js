// 计费等效 tokens：缓存读 0.1×、缓存写 1.25×。
// LOCAL 主卡已统一展示实际 token；这个次级口径只保留给 Claude 会话燃烧速度分析
// 和 daily 明细，不能再拿来与主卡或官方账户日桶相加。
function weightedTokens(inputTokens, outputTokens, cacheRead, cacheCreate) {
  return (inputTokens || 0) + (outputTokens || 0) + (cacheRead || 0) * 0.1 + (cacheCreate || 0) * 1.25;
}

module.exports = { weightedTokens };
