const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createKeyStore } = require('../src/server/services/keyStore.js');

const isDarwin = process.platform === 'darwin';
const SECURITY_BIN = '/usr/bin/security';

let tempDirs = [];
let keychainItems = [];

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-keystore-'));
  const service = 'Mana Test Keys ' + process.pid + '-' + Math.random().toString(36).slice(2);
  tempDirs.push(dir);
  return {keysFile: path.join(dir, '.keys.json'), service};
}

function trackKeychainItem(service, account) {
  keychainItems.push({service, account});
}

function cleanup() {
  if (isDarwin) {
    for (const {service, account} of keychainItems) {
      try {
        execFileSync(SECURITY_BIN, [
          'delete-generic-password',
          '-s', service,
          '-a', account,
        ], {encoding: 'utf8'});
      } catch {}
    }
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
  tempDirs = [];
  keychainItems = [];
}

function fileMode(p) { return fs.statSync(p).mode & 0o777; }

afterEach(cleanup);
after(cleanup);

test('Ssec1 addKey returns id and persists across store instances', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const first = createKeyStore({keysFile, service});
  const e1 = first.addKey('s', 'p1', 'secret-abc', '账号 A');
  trackKeychainItem(service, `p1:${e1.id}`);

  assert.ok(e1.id, 'should return id');
  assert.equal(e1.label, '账号 A');

  const second = createKeyStore({keysFile, service});
  const all = second.getAllKeysForProvider('s', 'p1');
  assert.equal(all.length, 1);
  assert.equal(all[0].apiKey, 'secret-abc');
});

test('Ssec2 metadata file does not contain plaintext secret', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const store = createKeyStore({keysFile, service});
  const e = store.addKey('s', 'p1', 'secret-abc', null);
  trackKeychainItem(service, `p1:${e.id}`);

  const text = fs.readFileSync(keysFile, 'utf8');
  const metadata = JSON.parse(text);
  assert.equal(text.includes('secret-abc'), false);
  assert.equal(metadata.__mana_key_store_version, 2);
  assert.equal(metadata.providers.p1[e.id], true);
});

test('Ssec3 multiple keys per provider independent', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const store = createKeyStore({keysFile, service});
  const e1 = store.addKey('s', 'github', 'token-A-1234567', '账号 A');
  const e2 = store.addKey('s', 'github', 'token-B-abcdefg', '账号 B');
  trackKeychainItem(service, `github:${e1.id}`);
  trackKeychainItem(service, `github:${e2.id}`);

  const all = store.getAllKeysForProvider('s', 'github');
  assert.equal(all.length, 2);
  assert.equal(all[0].apiKey, 'token-A-1234567');
  assert.equal(all[1].apiKey, 'token-B-abcdefg');

  const status = store.status('s');
  assert.equal(status.github.length, 2);
});

test('Ssec4 removeKey deletes specific key, keeps others', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const store = createKeyStore({keysFile, service});
  const e1 = store.addKey('s', 'p1', 'key-A-1111111', null);
  const e2 = store.addKey('s', 'p1', 'key-B-2222222', null);
  trackKeychainItem(service, `p1:${e1.id}`);
  trackKeychainItem(service, `p1:${e2.id}`);

  assert.equal(store.removeKey('s', 'p1', e1.id), true);
  const all = store.getAllKeysForProvider('s', 'p1');
  assert.equal(all.length, 1);
  assert.equal(all[0].id, e2.id);
});

test('Ssec5 legacy plaintext file migrates to multi-key Keychain', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  fs.writeFileSync(keysFile, JSON.stringify({github: 'gho_TESTtoken123456'}, null, 2));

  const store = createKeyStore({keysFile, service});
  const all = store.getAllKeysForProvider('s', 'github');
  assert.equal(all.length, 1);
  assert.equal(all[0].apiKey, 'gho_TESTtoken123456');

  trackKeychainItem(service, `github:${all[0].id}`);

  const text = fs.readFileSync(keysFile, 'utf8');
  const metadata = JSON.parse(text);
  assert.equal(text.includes('gho_TESTtoken123456'), false);
  assert.equal(metadata.__mana_key_store_version, 2);
});

test('Ssec6 metadata file is mode 0600', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const store = createKeyStore({keysFile, service});
  const e = store.addKey('s', 'p1', 'secret-abc', null);
  trackKeychainItem(service, `p1:${e.id}`);
  assert.equal(fileMode(keysFile), 0o600);
});

test('Ssec7 listKeys returns id, label, hint', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const store = createKeyStore({keysFile, service});
  const e = store.addKey('s', 'p1', 'sk-test-12345678', '账号 A');
  trackKeychainItem(service, `p1:${e.id}`);

  const list = store.listKeys('s', 'p1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, e.id);
  assert.equal(list[0].label, '账号 A');
  assert.equal(list[0].hint, 'sk-...5678');
});
