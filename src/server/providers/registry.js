const { ZhipuProvider } = require('./zhipu');
const { MinimaxProvider } = require('./minimax');
const { KimiProvider } = require('./kimi');
const { MoonshotProvider } = require('./moonshot');
const { DeepseekProvider } = require('./deepseek');
const { OpenRouterProvider } = require('./openrouter');
const { SiliconFlowProvider } = require('./siliconflow');
const { CodexProvider } = require('./codex');
const { GrokProvider } = require('./grok');
const { GithubCopilotProvider } = require('./githubCopilot');

function registerAll(deps = {}) {
  const providers = [
    new CodexProvider(deps),
    new GrokProvider(),
    new GithubCopilotProvider(),
    new ZhipuProvider(),
    new MinimaxProvider(),
    new KimiProvider(),
    new MoonshotProvider(),
    new DeepseekProvider(),
    new OpenRouterProvider(),
    new SiliconFlowProvider(),
  ];
  const map = new Map();
  for (const p of providers) {
    map.set(p.id, p);
  }
  return map;
}

module.exports = { registerAll };
