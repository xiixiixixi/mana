function createLocalUsageRouter(localUsageService) {
  const router = require('express').Router();

  // GET /api/local-usage — 本地 token 用量
  router.get('/local-usage', async (_req, res) => {
    try {
      const data = await localUsageService.get();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLocalUsageRouter };
