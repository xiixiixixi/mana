function createGithubAuthRouter(githubOAuth, keyStore, cache) {
  const router = require('express').Router();

  // POST /api/auth/github/device — 发起 Device Flow
  router.post('/auth/github/device', async (_req, res) => {
    if (!githubOAuth.isConfigured()) {
      return res.status(503).json({ error: 'GitHub OAuth 未配置。请在 .github-oauth.json 中设置 client_id。' });
    }

    try {
      const data = await githubOAuth.requestDeviceCode();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // POST /api/auth/github/poll — 轮询 Device Flow 状态
  router.post('/auth/github/poll', async (req, res) => {
    const { device_code } = req.body;
    if (!githubOAuth.isConfigured() || !device_code) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
      const result = await githubOAuth.pollAccessToken(device_code);

      if (result.status === 'success') {
        keyStore.addKey(null, 'github-copilot', result.accessToken, 'GitHub Copilot OAuth');
        if (cache.invalidate) cache.invalidate('github-copilot');
        return res.json({ status: 'success' });
      }

      res.json(result);
    } catch (err) {
      // GitHub 请求失败（代理超时等），返回 pending 让前端继续重试
      res.json({ status: 'pending' });
    }
  });

  // GET /api/auth/github/status — 检查 OAuth 状态
  router.get('/auth/github/status', (req, res) => {
    const keys = keyStore.getAllKeysForProvider(null, 'github-copilot');
    res.json({
      configured: githubOAuth.isConfigured(),
      hasToken: keys.length > 0,
    });
  });

  return router;
}

module.exports = { createGithubAuthRouter };