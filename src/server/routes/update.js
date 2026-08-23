// GET /api/update/status|check — 自更新检查（安装在 Swift 壳，见 main.swift SelfUpdate）
// status：命中缓存（Swift 每 180s 轮询）；check：force 强制刷新（settings 手动按钮/打开页面）
function createUpdateRouter(updater) {
  const router = require('express').Router();

  router.get('/update/status', (_req, res) => {
    updater.check().then(r => res.json(r));
  });
  router.get('/update/check', (_req, res) => {
    updater.check({ force: true }).then(r => res.json(r));
  });

  return router;
}

module.exports = { createUpdateRouter };
