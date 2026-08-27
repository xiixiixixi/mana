# services/

Domain logic. No HTTP, no Express. Pure factories wired together in `app.js`.

## STRUCTURE

```
services/
├── keyStore.js             Keys → macOS Keychain, metadata to .keys.json
├── cache.js                In-memory TTL Map, keyed by providerId
├── usageOrchestrator.js    One provider fetch: cache → cooldown → fetch → aggregate
├── localUsage.js           Local Agent usage scan (ZCode/OpenCode SQLite + Claude/Codex JSONL)
├── modelPricing.js         USD per 1M tokens, prefix-match lookup
├── updater.js              Self-update check: GitHub latest release (API → 302 redirect fallback)
└── githubOAuth.js          GitHub Device Flow, client_id only
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a key | `keyStore.js` `addKey()` | Writes keychain item with account `providerId:keyId` |
| Change cooldown after 429 | `usageOrchestrator.js` line 4 `COOLDOWN_MS` | Currently 90s. Also sets `lastGood` for stale fallback |
| Change cache TTL | Per-provider `cacheTTL` field | Set on provider object, consumed in orchestrator. Cache default 30s |
| Add a model price | `modelPricing.js` `PRICING` map | Key is prefix, matched via `startsWith` on lowercased model |
| Add a local usage source | `localUsage.js` `get()` | Add scan fn, push into `Promise.all`. `buildResult()` uses fixed local calendar day/Monday-week/month windows |
| Change OAuth scope | `githubOAuth.js` `requestDeviceCode()` body | Currently empty `scope` |
| Change session window | `localUsage.js` line 11 `SESSION_WINDOW_MS` | 5h. Drives currentSession + prediction |
| Update check / rate-limit fallback | `updater.js` `createUpdater()` | API first (notes/asset metadata); on 403/429/network error falls back to `github.com/<repo>/releases/latest` 302 Location → tag, dmg url is deterministic `<repo>/releases/download/<tag>/Mana.dmg`. Install itself lives in Swift (`main.swift` SelfUpdate). Repo owner is `xiixiixixi` — git remote still points at pre-rename `xiexiixixi` (GitHub redirects) |

## CONVENTIONS

- **Factory pattern**: every service exports `create*({ deps })`. Wiring happens in `app.js`, not here.
- **keyStore v2 format**: `.keys.json` stores metadata only (`providerId → {keyId: true}`), secrets live in Keychain. Legacy plaintext auto-migrates on first load. Account string is `${providerId}:${keyId}`, service name `TokenLens API Keys` (override via `TOKENLENS_KEYCHAIN_SERVICE`).
- **Multi-key**: `store[providerId]` is always an array. Orchestrator iterates all keys, aggregates `used` + `balance` by summing across successes, returns `keyCount`. Single key skips merge path.
- **No-key providers**: `apiType === 'oauth'` or `'local'` skip the key requirement and call `fetchUsage(null)`.
- **Orchestrator latency**: measured with `performance.now()` around the whole key loop, attached to result and to every error object.
- **429 handling**: sets `cooldown.get(providerId)` to `Date.now() + 90s`. During cooldown, returns `lastGood` with `status: 'rate_limited', stale: true`. If no `lastGood`, returns empty quotas.
- **localUsage sources**: exactly four tools. ZCode reads its `model_usage`; OpenCode reads the same per-assistant-message database used by `opencode stats`; Claude recursively reads its own project/subagent JSONL and keeps the latest record per `message.id` because Claude `/stats` groups dates in UTC and cannot satisfy local calendar windows; Codex reads its per-response `token_count` events, deduping repeat/fork copies by the full total+last usage state and assigning the earliest copied timestamp. Never use Codex thread totals or OpenCode session totals for daily buckets.
- **localUsage semantics**: the visible headline is each tool's own total token count. Attribution is always by calling tool (Claude Code/OpenCode/Codex/ZCode), never by model, provider, or API Key. Account/provider API totals are not displayed in or added to this ledger.
- **localUsage refresh**: four sources run in parallel with a 60s result cache; Codex per-rollout compact events are cached by file size/mtime, and app startup warms the scan in the background.
- **Session analysis**: messages grouped into 5h windows, computes currentSession, burnRate (last 1h), P90 session limit, and end prediction. Confidence scales with sample size (3+ = low, 5+ = high).
- **modelPricing**: prefix match, not exact. `'claude-sonnet-4'` matches `'claude-sonnet-4-20250514'`. Unknown models return 0 cost (intentional, not an error).
- **githubOAuth**: only `client_id` loaded from `.github-oauth.json`. No secret, no redirect URI. Token polling handles `authorization_pending` + `slow_down` separately.
- **Cost rounding**: `localUsage` rounds to 2 decimals. `modelPricing.calcCost` returns raw float, caller rounds.
