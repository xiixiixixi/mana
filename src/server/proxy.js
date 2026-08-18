const { ProxyAgent, setGlobalDispatcher } = require('undici');
const { execSync } = require('child_process');

// 让 Node.js 原生 fetch (undici) 走代理。
// 关键: undici 不会自动读取 HTTPS_PROXY 环境变量，必须显式 setGlobalDispatcher。
// 系统代理检测枚举全部网络服务（Wi-Fi/以太网/USB 网卡/自定义名称），不硬编码服务名。
function setupProxy() {
  const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;

  if (envProxy) {
    setGlobalDispatcher(new ProxyAgent(envProxy));
    console.log(`Using proxy from env: ${envProxy}`);
    return;
  }

  try {
    // 列出所有网络服务（首行是标题、带 * 前缀的是已禁用的，都要跳过）
    const services = execSync('networksetup -listallnetworkservices 2>/dev/null', { encoding: 'utf8' })
      .split('\n').slice(1).map(s => s.replace(/^\*/, '').trim()).filter(Boolean);

    for (const svc of services) {
      for (const cmd of ['-getsecurewebproxy', '-getwebproxy']) {
        const out = execSync(`networksetup ${cmd} "${svc}" 2>/dev/null`, { encoding: 'utf8' });
        const enabled = /Enabled: Yes/.test(out);
        const host = (out.match(/Server: (\S+)/) || [])[1];
        const port = (out.match(/Port: (\d+)/) || [])[1];
        if (enabled && host && port) {
          const url = `http://${host}:${port}`;
          process.env.http_proxy = url;
          process.env.https_proxy = url;
          setGlobalDispatcher(new ProxyAgent(url));
          console.log(`Using system proxy (${svc}): ${url}`);
          return;
        }
      }
    }
  } catch {}
}

module.exports = { setupProxy };
