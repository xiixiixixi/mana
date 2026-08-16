function createCache() {
  const store = new Map();

  function key(id) { return `usage:${id}`; }

  return {
    get(providerId) {
      const entry = store.get(key(providerId));
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key(providerId));
        return null;
      }
      return entry.data;
    },

    set(providerId, data, ttlSeconds = 30) {
      store.set(key(providerId), { data, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    invalidate(providerId) {
      store.delete(key(providerId));
    },

    invalidateAll() {
      store.clear();
    },
  };
}

module.exports = { createCache };
