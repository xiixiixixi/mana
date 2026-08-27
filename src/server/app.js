const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { registerAll } = require('./providers/registry');
const { createKeyStore } = require('./services/keyStore');
const { createCache } = require('./services/cache');
const { createLocalUsageService } = require('./services/localUsage');
const { createApiRouter } = require('./routes/api');
const { createKeysRouter } = require('./routes/keys');
const { createLocalUsageRouter } = require('./routes/localUsage');
const { createGithubAuthRouter } = require('./routes/githubAuth');
const { createConfigRouter } = require('./routes/config');
const { createUpdateRouter } = require('./routes/update');
const { createUpdater } = require('./services/updater');
const { createGithubOAuth } = require('./services/githubOAuth');
const { refreshProxy } = require('./proxy');

async function createApp() {
  const app = express();

  // Services
  const keyStore = createKeyStore();
  const cache = createCache();
  const localUsageService = createLocalUsageService();
  // Codex 首次建立跨 fork 去重索引需要读取较多本地日志；应用启动后即后台预热，
  // 用户打开菜单时复用同一个 in-flight 任务，不会重复扫描。
  localUsageService.get().catch(() => {});
  const githubOAuth = createGithubOAuth();
  const updater = createUpdater({ refreshProxyImpl: refreshProxy });
  const providers = registerAll({ keyStore, refreshProxy });

  // Middleware
  app.use(cookieParser());
  app.use(express.json());

  // Session: simple in-memory cookie-based session
  app.use((req, res, next) => {
    let sid = req.cookies?.sid;
    if (!sid) {
      sid = crypto.randomUUID();
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 86400000 });
    }
    req.sessionId = sid;
    next();
  });

  // Window control signal (for Tauri close button)
  const fs = require('fs');
  const SIGNAL_FILE = '/tmp/mana_window_action';
  app.post('/api/window-action', (req, res) => {
    try { fs.writeFileSync(SIGNAL_FILE, req.body.action || ''); } catch {}
    res.json({ok: true});
  });

  // Routes
  app.use('/api', createApiRouter(providers, keyStore, cache));
  app.use('/api/keys', createKeysRouter(providers, keyStore, cache));
  app.use('/api', createLocalUsageRouter(localUsageService));
  app.use('/api', createGithubAuthRouter(githubOAuth, keyStore, cache));
  app.use('/api', createConfigRouter());
  app.use('/api', createUpdateRouter(updater));

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'client')));

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
