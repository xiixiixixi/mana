const fs = require('fs');
const path = require('path');

// Device Flow 只需要 client_id，不需要 client_secret 和 redirect_uri
const CONFIG_FILE = path.join(__dirname, '..', '..', '..', '.github-oauth.json');

function createGithubOAuth() {
  let clientId = null;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      clientId = config.client_id || null;
    }
  } catch (e) {
    console.error('Failed to load GitHub OAuth config:', e.message);
  }

  return {
    getClientId() { return clientId; },
    isConfigured() { return !!clientId; },

    async requestDeviceCode() {
      const r = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope: '' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error_description || data.error);
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval || 5,
      };
    },

    async pollAccessToken(deviceCode) {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      if (data.error) {
        if (data.error === 'authorization_pending') return { status: 'pending' };
        if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval || 10 };
        return { status: 'error', error: data.error_description || data.error };
      }

      const accessToken = data.access_token;
      if (!accessToken) return { status: 'error', error: 'No access token' };

      return { status: 'success', accessToken };
    },
  };
}

module.exports = { createGithubOAuth };