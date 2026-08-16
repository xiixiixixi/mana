function createKeysRouter(providers, keyStore, cache) {
  const router = require('express').Router();

  router.get('/status', (req, res) => {
    res.json(keyStore.status(req.sessionId));
  });

  router.post('/', (req, res) => {
    const {providerId, apiKey, label} = req.body;
    if (!providerId || !apiKey) {
      return res.status(400).json({error: 'providerId and apiKey required'});
    }
    const provider = providers.get(providerId);
    if (!provider) {
      return res.status(404).json({error: `Provider ${providerId} not found`});
    }
    if (!provider.validateKey(apiKey)) {
      return res.status(400).json({error: 'Invalid API key format'});
    }
    const entry = keyStore.addKey(req.sessionId, providerId, apiKey, label);
    if (!entry) {
      return res.status(500).json({error: 'Failed to save to Keychain'});
    }
    cache.invalidate(providerId);
    res.json({
      id: entry.id,
      providerId,
      label: entry.label,
      hint: entry.apiKey.length > 7 ? entry.apiKey.slice(0, 3) + '...' + entry.apiKey.slice(-4) : '***',
    });
  });

  router.delete('/:keyId', (req, res) => {
    const {keyId} = req.params;
    const status = keyStore.status(req.sessionId);
    let providerId = null;
    for (const [pid, arr] of Object.entries(status)) {
      if (arr.some(k => k.id === keyId)) { providerId = pid; break; }
    }
    if (!providerId) return res.status(404).json({error: 'Key not found'});
    const ok = keyStore.removeKey(req.sessionId, providerId, keyId);
    if (ok) cache.invalidate(providerId);
    res.json({ok});
  });

  return router;
}

module.exports = {createKeysRouter};
