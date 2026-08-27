# PROVIDERS

11 platform adapters behind one contract: `fetchUsage(apiKey) → buildUsage({status, plan, quotas})`.

## STRUCTURE

```
providers/
├── base.js          BaseProvider: ctor(config, deps), fetchUsage, validateKey, getMetadata, buildUsage
├── common.js        Shared helpers: httpGetJson, formatResetAt, formatDuration, buildBalanceQuota
├── registry.js      registerAll(deps) → Map<id, BaseProvider>
├── codex.js         OpenAI Codex CLI             apiType=local  region=global  ttl=30
├── githubCopilot.js GitHub Copilot               apiType=oauth  region=global  ttl=300
├── grok.js          xAI Grok                     apiType=apiKey region=global  ttl=60
├── zhipu.js         智谱 GLM                      apiType=apiKey region=cn     ttl=30
├── minimax.js       MiniMax                      apiType=apiKey region=cn     ttl=30
├── kimi.js          Kimi                         apiType=apiKey region=cn     ttl=30
├── moonshot.js      Moonshot API                 apiType=apiKey region=cn     ttl=30
├── deepseek.js      DeepSeek                     apiType=apiKey region=cn     ttl=30
├── openrouter.js    OpenRouter                   apiType=apiKey region=global ttl=30
└── siliconflow.js   SiliconFlow                  apiType=apiKey region=cn     ttl=30
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Provider contract | `base.js` | Extend `BaseProvider`, implement `fetchUsage(apiKey)`, return via `this.buildUsage(...)` |
| Register a provider | `registry.js` `registerAll()` | Push `new XProvider()` into the array; key is `provider.id` |
| HTTP / time helpers | `common.js` | `httpGetJson` (8s timeout, `.status` on error), `formatResetAt`, `formatDuration`, `buildBalanceQuota` |
| Quota object shape | `common.js` `buildBalanceQuota` | `{label, used, total, unit, balance, resetIn, window}`. Balance-only quotas zero out used/total |
| Pass cache/keyStore | `registry.js` `registerAll(deps)` | Currently unused by any provider; extend ctor calls if a provider needs deps |

## CONVENTIONS

- **apiType**: `oauth` / `local` providers skip the key form in settings.html. Credentials auto-detected (OAuth tokens, local config files). `apiKey` providers require a user-supplied key.
- **Codex live usage**: prefer the installed Codex `app-server` method `account/rateLimits/read` for live quota; fall back to the legacy OAuth HTTP endpoint, then a clearly marked local rollout snapshot. `account/usage/read` may still be fetched for compatibility, but it is not displayed in or added to the four-tool token ledger. Run the bundled Node with `--use-system-ca` and refresh macOS proxy state before live requests.
- **Status values**: `'active'`, `'inactive'`, `'warning'`. Orchestrator stamps `'error'` on thrown exceptions, `'no_key'` when key missing.
- **Quotas**: array of `{label, used, total, unit, balance, resetIn, window}`. Percent-bar providers fill `used`/`total`; balance-only providers use `buildBalanceQuota` and leave them 0.
- **resetIn**: always run epoch ms or ISO string through `formatResetAt()`. Returns `'Xm'` / `'Xh Ym'` / `'N天'` / `'即将重置'` / `null`.
- **No Keychain access from providers**. `apiKey` arrives as a plain string. Reads happen in `routes/keys.js` upstream.
- **Errors**: throw freely from `fetchUsage`. `httpGetJson` errors carry `.status` (HTTP code) for upstream retry mapping.
- **cacheTTL** (seconds): respected by the cache service in `services/cache`. OAuth providers (Copilot) use 300s to spare token refresh; key-based providers default to 30s.
- **region**: `'cn'` vs `'global'`. Purely informational for UI grouping, no behavior switch.
