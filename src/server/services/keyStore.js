const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, '..', '..', '..', '.keys.json');
const KEY_STORE_VERSION = 2;
const KEYCHAIN_STORAGE = 'macos-keychain';
const DEFAULT_SERVICE = 'Mana API Keys';
// 2026-08 由 TokenLens 改名 Mana：旧服务的 Keychain 条目自动迁移到新服务名（原条目保留作备份）
const LEGACY_SERVICE = 'TokenLens API Keys';
const SECURITY_BIN = '/usr/bin/security';

function createKeyStore(options = {}) {
  const keysFile = options.keysFile || KEYS_FILE;
  const service = options.service || process.env.MANA_KEYCHAIN_SERVICE || DEFAULT_SERVICE;
  let store = {};

  loadStore();

  function loadStore() {
    if (!fs.existsSync(keysFile)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    } catch (e) {
      console.error('Failed to load keys:', e.message);
      store = {};
      return;
    }

    if (isV2Metadata(data)) {
      store = loadKeysFromKeychain(data.providers, service);
      return;
    }

    if (isLegacyPlaintextStore(data)) {
      store = {};
      for (const [pid, apiKey] of Object.entries(data)) {
        const keyId = crypto.randomUUID();
        if (writeKeychainKey(service, pid, keyId, apiKey)) {
          store[pid] = store[pid] || [];
          store[pid].push({id: keyId, label: null, apiKey, createdAt: new Date().toISOString()});
        }
      }
      writeMetadataFile(keysFile, service, store);
      return;
    }

    console.error('Failed to load keys: unsupported key store format');
    store = {};
  }

  function saveMetadata() {
    writeMetadataFile(keysFile, service, store);
  }

  return {
    addKey(_sid, providerId, apiKey, label) {
      const keyId = crypto.randomUUID();
      if (!writeKeychainKey(service, providerId, keyId, apiKey)) {
        console.error(`Failed to save key for provider "${providerId}" to macOS Keychain`);
        return null;
      }
      store[providerId] = store[providerId] || [];
      const entry = {id: keyId, label: label || null, apiKey, createdAt: new Date().toISOString()};
      store[providerId].push(entry);
      saveMetadata();
      return entry;
    },

    removeKey(_sid, providerId, keyId) {
      const arr = store[providerId] || [];
      const idx = arr.findIndex(k => k.id === keyId);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      if (arr.length === 0) delete store[providerId];
      deleteKeychainKey(service, providerId, keyId);
      saveMetadata();
      return true;
    },

    getKey(_sid, providerId, keyId) {
      const arr = store[providerId] || [];
      return arr.find(k => k.id === keyId) || null;
    },

    listKeys(_sid, providerId) {
      return (store[providerId] || []).map(k => ({
        id: k.id,
        label: k.label,
        hint: k.apiKey.length > 7 ? k.apiKey.slice(0, 3) + '...' + k.apiKey.slice(-4) : '***',
      }));
    },

    getAllKeysForProvider(_sid, providerId) {
      return (store[providerId] || []).map(k => ({
        ...k,
        hint: k.apiKey && k.apiKey.length > 7 ? k.apiKey.slice(0, 3) + '...' + k.apiKey.slice(-4) : '***',
      }));
    },

    status(_sid) {
      const result = {};
      for (const [pid, arr] of Object.entries(store)) {
        result[pid] = arr.map(k => ({
          id: k.id,
          label: k.label,
          configured: true,
          hint: k.apiKey.length > 7 ? k.apiKey.slice(0, 3) + '...' + k.apiKey.slice(-4) : '***',
        }));
      }
      return result;
    },
  };
}

function loadKeysFromKeychain(providers, service) {
  const loaded = {};
  for (const [pid, keys] of Object.entries(providers)) {
    const keyIds = keys === true ? [] : Object.keys(keys);
    loaded[pid] = [];
    for (const keyId of keyIds) {
      let apiKey = readKeychainKey(service, pid, keyId);
      if (apiKey === null && service !== LEGACY_SERVICE) {
        // 旧服务名（TokenLens 时代）迁移：读到即写入新服务，原条目保留
        const legacy = readKeychainKey(LEGACY_SERVICE, pid, keyId);
        if (legacy !== null) {
          if (writeKeychainKey(service, pid, keyId, legacy)) {
            console.log(`Migrated keychain item ${pid}/${keyId} from "${LEGACY_SERVICE}" to "${service}"`);
            apiKey = legacy;
          }
        }
      }
      if (apiKey === null) {
        console.warn(`Keychain item missing for provider "${pid}" keyId "${keyId}"; leaving it unconfigured`);
        continue;
      }
      loaded[pid].push({id: keyId, label: null, apiKey, createdAt: null});
    }
  }
  return loaded;
}

function writeKeychainKey(service, providerId, keyId, apiKey) {
  try {
    execFileSync(SECURITY_BIN, [
      'add-generic-password', '-U',
      '-s', service,
      '-a', `${providerId}:${keyId}`,
      '-w', apiKey,
    ], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function readKeychainKey(service, providerId, keyId) {
  try {
    const raw = execFileSync(SECURITY_BIN, [
      'find-generic-password',
      '-s', service,
      '-a', `${providerId}:${keyId}`,
      '-w',
    ], { encoding: 'utf8' });
    return raw.replace(/\r?\n$/, '');
    return null;
  } catch {
    return null;
  }
}

function deleteKeychainKey(service, providerId, keyId) {
  try {
    execFileSync(SECURITY_BIN, [
      'delete-generic-password',
      '-s', service,
      '-a', `${providerId}:${keyId}`,
    ], { encoding: 'utf8' });
    return true;
  } catch (e) {
    if (!isSecurityNotFound(e)) {
      console.warn(`Failed to delete key for provider "${providerId}" keyId "${keyId}" from macOS Keychain`);
    }
    return false;
  }
}

function writeMetadataFile(keysFile, service, store) {
  const tmp = keysFile + '.tmp';
  const providers = {};
  for (const [pid, arr] of Object.entries(store)) {
    providers[pid] = {};
    for (const k of arr) {
      providers[pid][k.id] = true;
    }
  }
  const metadata = {
    __mana_key_store_version: KEY_STORE_VERSION,
    storage: KEYCHAIN_STORAGE,
    service,
    providers,
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, keysFile);
    fs.chmodSync(keysFile, 0o600);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch {}
    console.error('Failed to save keys metadata:', e.message);
    return false;
  }
}

function isV2Metadata(data) {
  // 兼容 TokenLens 时代的元数据文件（__tokenlens_key_store_version），读取时一并接受
  const v2 = data.__mana_key_store_version === KEY_STORE_VERSION
    || data.__tokenlens_key_store_version === KEY_STORE_VERSION;
  return isPlainObject(data)
    && v2
    && data.storage === KEYCHAIN_STORAGE
    && isPlainObject(data.providers);
}

function isLegacyPlaintextStore(data) {
  return isPlainObject(data)
    && typeof data.__mana_key_store_version !== 'number'
    && typeof data.__tokenlens_key_store_version !== 'number'
    && Object.values(data).every(value => typeof value === 'string');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSecurityNotFound(error) {
  const output = String(error.stderr || error.stdout || '').toLowerCase();
  return output.includes('could not be found') || output.includes('not found');
}

module.exports = { createKeyStore };
