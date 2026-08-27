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

// 自愈：升级整包替换丢 .keys.json（v0.2.10/0.2.11 安装器无搬运逻辑）后，
// 密钥本体仍在 Keychain，索引应能按 pid:keyId 规则扫描重建，用户无需重配
test('Ssec8 rebuilds metadata from Keychain when index file is lost', {skip: !isDarwin}, () => {
  const {keysFile, service} = createFixture();
  const storeA = createKeyStore({keysFile, service});
  const e1 = storeA.addKey('s', 'deepseek', 'sk-recover-1111111', null);
  const e2 = storeA.addKey('s', 'zhipu', 'sk-recover-2222222', null);
  trackKeychainItem(service, `deepseek:${e1.id}`);
  trackKeychainItem(service, `zhipu:${e2.id}`);

  // 索引丢失：全新路径（文件不存在）+ 同一 Keychain service
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-keystore-'));
  tempDirs.push(dir);
  const lostFile = path.join(dir, '.keys.json');
  // 重建逻辑只需要账号索引；测试把这一步注入，避免固定依赖当前登录钥匙串，
  // 仍然会从真实 macOS Keychain 读取刚写入的两条密钥并验证恢复结果。
  const storeB = createKeyStore({
    keysFile: lostFile,
    service,
    listAccounts: () => [`deepseek:${e1.id}`, `zhipu:${e2.id}`],
  });

  const status = storeB.status('s');
  assert.equal(status.deepseek.length, 1, 'deepseek key should be recovered');
  assert.equal(status.zhipu.length, 1, 'zhipu key should be recovered');
  assert.equal(storeB.getKey('s', 'deepseek', status.deepseek[0].id).apiKey, 'sk-recover-1111111');

  // 重建后的元数据应落盘（下次启动走正常路径）
  const meta = JSON.parse(fs.readFileSync(lostFile, 'utf8'));
  assert.equal(meta.providers.deepseek[status.deepseek[0].id], true);
  assert.equal(meta.providers.zhipu[status.zhipu[0].id], true);
});
