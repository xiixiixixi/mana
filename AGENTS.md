# PROJECT KNOWLEDGE BASE

## OVERVIEW
macOS menu bar app monitoring AI token usage across 10 providers. Swift (AppKit + WKWebView) shell spawns a Node.js Express subprocess; all API keys stored in macOS Keychain.

## STRUCTURE
```
mana/  (repo root = project root)
├── server.js              Node entry, starts Express on :41119
├── src/cli.js             `mana` CLI (usage/summary/local → 127.0.0.1:41119)
├── src-swift/             Swift menu bar app (compiled separately)
│   ├── main.swift         NSStatusItem + NSPopover + WKWebView + Process spawn + UNNotifications
│   ├── gen_icon.swift     Renders App icon (block-bar motif) → icons/icon-1024.png
│   └── build.sh           Compiles Swift + bundles Node runtime + dylibs → .app + .dmg
├── src/client/            Frontend (vanilla JS, no framework, monospace/terminal style)
│   ├── popover.html       Main UI: aligned quota grid (剩余% + ↻重置), LOCAL token trend card
│   └── settings.html      Preferences (notify/menubar) + API keys + GitHub OAuth
├── src/server/
│   ├── app.js             Express setup, static serve + session cookie + routes
│   ├── proxy.js           Reads macOS system proxy (networksetup) → undici setGlobalDispatcher
│   ├── providers/         10 platform adapters, see providers/AGENTS.md
│   ├── routes/            api.js (usage+summary), keys.js (CRUD), githubAuth.js, localUsage.js, config.js
│   └── services/          keyStore + cache + orchestrator + remaining.js, see services/AGENTS.md
└── test/                  node --test
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a new AI platform | `src/server/providers/` | Copy an existing provider, register in `registry.js`; set `consoleUrl` for the card link |
| Change menu bar icon/mode | `src-swift/main.swift` `applyMenubar()` + settings PREFERENCES | Attention mode: anchor gauge always; per-provider item only when remaining < `ui.attentionPct` (default 80), sorted most-urgent-last (rightmost). **Notch constraint** (see ANTI-PATTERNS) |
| Quota display semantics | `src/server/services/remaining.js` (server) + `rem()` in popover.html + `refresh()` in main.swift | **All three must stay in sync**: progress is always "remaining" (100-used/total, or balance/total) |
| Reset countdown | provider quota `resetIn` field | Balance-type quotas show "↻ --" (no reset cycle); windowed providers fill resetIn (formatResetAt/formatDuration) |
| Notifications | `main.swift` `checkNotifications()` + `/api/config` | Threshold dedup via UserDefaults `tln.notifySnap`; pause via right-click menu (`tln.pauseUntil`) |
| App config (.config.json) | `src/server/routes/config.js` | notify + ui sections; read by Node routes AND Swift `AppConfig.load()`; bundled at build time |
| Fix popover white screen | `src-swift/main.swift` `startNode()` | Bundled node path resolution |
| GitHub OAuth flow | `settings.html` `githubAuth()` + `src/server/routes/githubAuth.js` | Device flow, auto-copies code + opens browser |
| Build DMG for distribution | `bash src-swift/build.sh` | Bundles node binary + 19 dylibs + server code + npm deps + AppIcon.icns |
| Regenerate app icon | `cd src-swift && swift gen_icon.swift icons/icon-1024.png && iconutil -c icns icons/AppIcon.iconset -o icons/AppIcon.icns` | Block-bar motif (white/gray/orange rows on black) |
| Multi-key per-provider | `src/server/routes/api.js` `collectUsage()` | Expands multi-key providers into per-key entries |
| CLI | `src/cli.js`, `npm link` | `mana usage --json` / `summary` / `local` |

## CONVENTIONS

- **Two runtimes**: Swift GUI spawns Node subprocess. Port `41119` hardcoded in both. Don't change one without the other.
- **Bundled vs dev mode**: `startNode()` checks `Bundle.main.resourcePath` for bundled server.js. Dev mode falls back to `#filePath` source directory + system node.
- **Custom URL scheme**: `mana://` for Swift-WebView IPC. Handlers: `mana://refresh`, `mana://settings`, `mana://open?url=`, `mana://copy?text=`, `mana://notify-test`. Settings WebView must have `navigationDelegate` + `uiDelegate` set.
- **WKWebView limitations**: No `window.open()`. External URLs handled via `mana://open?url=` → `NSWorkspace.shared.open()`. `window.close()` requires `WKUIDelegate.webViewDidClose`.
- **Proxy**: Node uses undici (doesn't read `HTTPS_PROXY`). `proxy.js` calls `networksetup -getsecurewebproxy` to detect macOS system proxy.
- **Remaining semantics rule**: progress shown to users is ALWAYS "how much is left". Never reintroduce "used %" display.
- **UI style**: terminal/CLI aesthetic — monospace (Space Mono), strict column grid (`.qgrid`), discrete block bars (10 cells), no letter/abbreviation icons, no cost ($) figures in popover.
- **Kimi/Moonshot dual-region**: CN and international keys are isolated (401 cross-use). Moonshot retries `.cn` then `.ai`; Kimi surfaces a clear 401 message.

## ANTI-PATTERNS

- **Don't use Electron/Tauri**. Both were tried and removed. Swift native is the only shell.
- **Don't set `statusItem.menu`**. It hijacks left-click. Use `button.sendAction(on: [.leftMouseUp, .rightMouseUp])` + `NSApp.currentEvent` to distinguish.
- **Don't use `URLComponents` for `mana://` URLs**. Query parsing fails on custom schemes. Parse `absoluteString` manually with `range(of:)`.
- **Don't rely on system PATH for GUI apps**. Menu bar apps inherit minimal PATH. Find node at known paths (`/opt/homebrew/bin/node` etc.) or bundle it.
- **Don't suppress Node errors with `Stdio::null()`** in dev mode. Use `Stdio::inherit()` when debugging.
- **Don't show cost/USD figures in the UI** (deliberate product decision 2026-08). Token counts only.
- **Don't use block glyphs (█░) for alignment-critical HTML bars** — font fallback breaks monospace metrics; use CSS cells (`.qbar b`). Block glyphs are fine in the menu bar status title.
- **Don't add many always-on menubar items**. 14" notched MacBook: overflow status items are silently hidden behind the notch (verified experimentally — an 8-item test app rendered zero). Menubar shows only attention-needed providers (below `ui.attentionPct`); healthy ones live in the popover.

## COMMANDS

```bash
npm start                                          # Dev: start Express backend on :41119 (kill the .app first — port conflict)
npm test                                           # Run node --test
bash src-swift/build.sh                            # Build .app + .dmg (bundled Node, ~41MB DMG) — 本机部署用（打包 .keys.json/.config.json）
DIST=1 bash src-swift/build.sh                     # Build 干净分发 DMG — 不含本机 Keychain 元数据/配置，给别的机器装
open src-swift/build/Mana.app                 # Launch built app
npm link                                           # Install `mana` CLI
```

**重新部署到 /Applications 时必须杀两个进程**（否则孤儿 Node 会占着 41119 端口让新代码静默失效）：
```bash
osascript -e 'tell application "Mana" to quit'; pkill -f "Mana.app/Contents/MacOS"; pkill -f "Mana.app/Contents/Resources/node"
```

## NOTES

- DMG is ad-hoc signed (no Apple Developer cert). First launch: right-click → Open to bypass Gatekeeper.
- Node binary in bundle depends on 19 Homebrew dylibs. Build script recursively collects + fixes `@loader_path` + re-signs.
- `libnode.137.dylib` is 57MB, dominates bundle size. DMG compression brings it to ~41MB.
- Frontend is vanilla JS (no React/Babel). Web fonts load from Google Fonts CDN (Space Mono); falls back to SF Mono/Menlo offline.
- API keys: stored in macOS Keychain (`security add-generic-password`), service `Mana API Keys`. Never written to files.
- `.github-oauth.json`, `.keys.json`, `.config.json` are bundled into Resources at build time.
- The user's daily instance lives in `/Applications/Mana.app` and holds port 41119 — rebuild + replace there to ship changes to the running app.
