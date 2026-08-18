const { setupProxy } = require('./src/server/proxy');
const os = require('os');
const path = require('path');
const fs = require('fs');

setupProxy();

const { createApp } = require('./src/server/app');

// 端口策略：优先 41119，被占则依次尝试 41120-41128，实际端口写入端口文件供
// Swift 壳与 CLI 读取（ popover/settings 页用相对路径，天然跟随任意端口）。
const PORT_FILE = path.join(os.homedir(), '.local', 'share', 'mana', 'port');

function writePortFile(port) {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
    fs.writeFileSync(PORT_FILE, String(port));
  } catch {}
}

function listenWithFallback(app, attempt = 0) {
  const ports = [];
  for (let p = 41119; p <= 41128; p++) ports.push(process.env.PORT && p === 41119 ? Number(process.env.PORT) : p);
  const port = ports[attempt];
  if (port == null) {
    console.error('No available port in 41119-41128');
    process.exit(1);
  }
  const server = app.listen(port);
  server.on('listening', () => {
    console.log(`Mana running at http://localhost:${port}`);
    writePortFile(port);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < ports.length - 1) {
      console.log(`Port ${port} in use, trying ${ports[attempt + 1]}...`);
      listenWithFallback(app, attempt + 1);
    } else {
      console.error('Failed to start:', err.message);
      process.exit(1);
    }
  });
}

createApp().then(listenWithFallback).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
