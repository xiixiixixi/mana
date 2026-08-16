const fs = require('fs');
const path = require('path');

// GET/POST /api/config — 通知与界面配置（.config.json，Swift 端每次刷新时读取）
const CONFIG_FILE = path.join(__dirname, '..', '..', '..', '.config.json');

const DEFAULTS = {
  notify: {
    enabled: true,        // 配额阈值通知总开关
    warnPct: 20,          // 剩余百分比警告阈值
    criticalPct: 10,      // 剩余百分比紧急阈值
    balanceWarn: 2,       // 余额型（无总额）绝对值警告阈值
    // 暂停状态只在 Swift 端 UserDefaults（tln.pauseUntil），避免双端写文件竞争
  },
  ui: {
    menubarMode: 2,       // 1=仅图标 2=名字+剩余% 3=名字+块条
    attentionPct: 80,     // 菜单栏注意力阈值：剩余低于此值的平台才常驻菜单栏（刘海屏空间有限）
  },
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      notify: { ...DEFAULTS.notify, ...(raw.notify || {}) },
      ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function createConfigRouter() {
  const router = require('express').Router();

  router.get('/config', (_req, res) => {
    res.json(readConfig());
  });

  router.post('/config', (req, res) => {
    const cur = readConfig();
    const body = req.body || {};
    if (body.notify) cur.notify = { ...cur.notify, ...body.notify };
    if (body.ui) cur.ui = { ...cur.ui, ...body.ui };
    try {
      writeConfig(cur);
      res.json(cur);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createConfigRouter, readConfig, writeConfig, CONFIG_FILE };
