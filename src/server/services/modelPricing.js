// 模型定价 (USD per million tokens)
// 来源: Anthropic/OpenAI/DeepSeek 官方定价页

const PRICING = {
  // Claude 系列
  'claude-opus-4':  { inputPerM: 15,    outputPerM: 75,  cacheReadPerM: 1.875,  cacheWritePerM: 18.75 },
  'claude-sonnet-4': { inputPerM: 3,    outputPerM: 15,  cacheReadPerM: 0.375,  cacheWritePerM: 3.75 },
  'claude-haiku-3.5': { inputPerM: 0.8, outputPerM: 4,   cacheReadPerM: 0.08,   cacheWritePerM: 0.8 },
  'claude-3.5-sonnet': { inputPerM: 3,  outputPerM: 15,  cacheReadPerM: 0.375,  cacheWritePerM: 3.75 },
  'claude-3-haiku': { inputPerM: 0.25,  outputPerM: 1.25, cacheReadPerM: 0.03,  cacheWritePerM: 0.3 },

  // GPT 系列
  'gpt-5.5':       { inputPerM: 10,    outputPerM: 30,   cacheReadPerM: 2.5,   cacheWritePerM: 10 },
  'gpt-5.4':       { inputPerM: 2.5,   outputPerM: 10,   cacheReadPerM: 0.625, cacheWritePerM: 2.5 },
  'gpt-5.4-mini':  { inputPerM: 0.3,   outputPerM: 1.2,  cacheReadPerM: 0.075, cacheWritePerM: 0.3 },
  'o3':            { inputPerM: 2,      outputPerM: 8,    cacheReadPerM: 0.5,   cacheWritePerM: 2 },
  'o4-mini':       { inputPerM: 1.5,   outputPerM: 6,    cacheReadPerM: 0.375, cacheWritePerM: 1.5 },

  // Codex 旧版 (null model，无法确定具体模型，不计费)
  'codex':         { inputPerM: 0,     outputPerM: 0,    cacheReadPerM: 0,     cacheWritePerM: 0 },

  // 国内模型 (免费或低价，标 0)
  'glm':           { inputPerM: 0,     outputPerM: 0,    cacheReadPerM: 0,     cacheWritePerM: 0 },
  'deepseek':      { inputPerM: 0.27,  outputPerM: 1.10, cacheReadPerM: 0.07,  cacheWritePerM: 0.27 },
  'kimi':          { inputPerM: 0,     outputPerM: 0,    cacheReadPerM: 0,     cacheWritePerM: 0 },
  'minimax':       { inputPerM: 0,     outputPerM: 0,    cacheReadPerM: 0,     cacheWritePerM: 0 },
};

function lookupPricing(model) {
  if (!model) return { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

  // 精确匹配
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of Object.entries(PRICING)) {
    if (lower.startsWith(prefix)) return pricing;
  }

  // 默认: 0（未知模型）
  return { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
}

function calcCost(model, inputTokens, outputTokens, cacheRead, cacheCreate) {
  const p = lookupPricing(model);
  return (inputTokens / 1e6) * p.inputPerM
       + (outputTokens / 1e6) * p.outputPerM
       + (cacheRead / 1e6) * p.cacheReadPerM
       + (cacheCreate / 1e6) * p.cacheWritePerM;
}

module.exports = { lookupPricing, calcCost };
