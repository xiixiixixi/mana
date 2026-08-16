const { ProxyAgent, setGlobalDispatcher } = require('undici');
const { execSync } = require('child_process');

// 让 Node.js 原生 fetch (undici) 走代理。
// 关键: undici 不会自动读取 HTTPS_PROXY 环境变量，必须显式 setGlobalDispatcher。
// Rust/Tauri 应用（如 cc-switch）自动读取系统代理，但 Node.js 不会。
function setupProxy() {
  const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;

  if (envProxy) {
    setGlobalDispatcher(new ProxyAgent(envProxy));
    console.log(`Using proxy from env: ${envProxy}`);
    return;
  }

  try {
    const proxy = execSync("networksetup -getsecurewebproxy Wi-Fi 2>/dev/null | grep Server | awk '{print $2}'", { encoding: 'utf8' }).trim();
    const port = execSync("networksetup -getsecurewebproxy Wi-Fi 2>/dev/null | grep Port | awk '{print $2}'", { encoding: 'utf8' }).trim();
    if (proxy && port) {
      const url = `http://${proxy}:${port}`;
      process.env.http_proxy = url;
      process.env.https_proxy = url;
      setGlobalDispatcher(new ProxyAgent(url));
      console.log(`Using system proxy: ${url}`);
    }
  } catch {}
}

module.exports = { setupProxy };
