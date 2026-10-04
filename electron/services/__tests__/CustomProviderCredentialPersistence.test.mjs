import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const managerSource = read('../CredentialsManager.ts');
const cryptoSource = read('../credentialFallbackCrypto.ts');
const ipcSource = read('../../ipcHandlers.ts');
const customRegion = ipcSource.slice(ipcSource.indexOf('// Custom Provider Handlers'), ipcSource.indexOf("safeHandle('switch-to-custom-provider'"))
  + ipcSource.slice(ipcSource.indexOf('// cURL Provider Handlers'), ipcSource.indexOf("safeHandle('switch-to-curl-provider'"));
assert.ok(customRegion.includes("safeHandle('delete-custom-provider'"), 'bound the actual custom settings IPC region');
const provider = { id: 'test-provider', name: 'Local provider', curlCommand: 'curl http://localhost:1234 -d \'{"prompt":"{{TEXT}}"}\'', responsePath: 'answer', multimodal: false };
const plain = (value) => JSON.parse(JSON.stringify(value));

// Execute current source, including real encrypted persistence and filesystem I/O.
// Only Electron's OS encryption primitive and unrelated modules are substituted.
function env(t, platform, { keyring = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-credential-test-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const state = { keyring, decryptDenied: false, encryptDenied: false };
  const logs = [];
  const consoleStub = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, (...args) => logs.push(args.join(' '))]));
  const electron = {
    app: { getPath: () => userData, isPackaged: false, getVersion: () => 'test' },
    safeStorage: {
      isEncryptionAvailable: () => state.keyring,
      getSelectedStorageBackend: () => platform === 'win32' ? 'dpapi' : 'keychain',
      encryptString(text) {
        if (state.encryptDenied) throw new Error('OS encryption denied');
        return Buffer.concat([Buffer.from('TEST'), Buffer.from(text)]);
      },
      decryptString(bytes) {
        if (state.decryptDenied) throw new Error('OS decryption denied');
        return Buffer.from(bytes).subarray(4).toString();
      },
    },
  };
  const cryptoModule = { exports: {} };
  vm.runInNewContext(compile(cryptoSource), { module: cryptoModule, exports: cryptoModule.exports, require, Buffer });
  function manager() {
    const module = { exports: {} };
    vm.runInNewContext(compile(managerSource), {
      module, exports: module.exports, console: consoleStub, Buffer, process: { platform, env: {} },
      require(id) {
        if (id === 'electron') return electron;
        if (id === './credentialFallbackCrypto') return cryptoModule.exports;
        if (id.startsWith('../')) return {};
        return require(id);
      },
    });
    const cm = Object.create(module.exports.CredentialsManager.prototype);
    cm.credentials = {}; cm.keyringUnreadable = false; cm.keyIdentityMismatch = false; cm.reentryRequired = false;
    cm.init();
    return cm;
  }
  function ipc(cm, { runtimeDenied = false } = {}) {
    const handlers = new Map(); const events = []; const module = { exports: {} };
    vm.runInNewContext(compile(customRegion), {
      module, exports: module.exports, console: consoleStub, Error,
      TEXT_PLACEHOLDER_RE: /\{\{\s*TEXT\s*\}\}/,
      safeHandle: (channel, fn) => handlers.set(channel, fn),
      require: (id) => { assert.equal(id, './services/CredentialsManager'); return { CredentialsManager: { getInstance: () => cm } }; },
      refreshRuntimeDefaultIfUnavailable: async () => { events.push('refresh'); if (runtimeDenied) throw new Error('PRIVATE endpoint/token/path'); },
      broadcastCredentialsChanged: () => events.push('broadcast'),
    });
    return {
          save: p => handlers.get('save-custom-provider')({}, p), delete: id => handlers.get('delete-custom-provider')({}, id), read: () => handlers.get('get-custom-providers')(),
          saveCurl: p => handlers.get('save-curl-provider')({}, p), deleteCurl: id => handlers.get('delete-curl-provider')({}, id), readCurl: () => handlers.get('get-curl-providers')(), events,
        };
  }
  const snapshot = () => Object.fromEntries(['credentials.enc', 'credentials.fallback.enc'].filter(file => fs.existsSync(path.join(userData, file))).map(file => [file, fs.readFileSync(path.join(userData, file)).toString('hex')]));
  const denyDisk = () => {
    for (const file of ['credentials.enc.tmp', 'credentials.fallback.enc.tmp']) fs.mkdirSync(path.join(userData, file));
  };
  return { state, manager, ipc, snapshot, denyDisk, logs, userData };
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: denied save/delete are not acknowledged and intact providers recover on next healthy load`, async t => {
    const e = env(t, platform); let cm = e.manager();
    cm.saveCustomProvider({ ...provider, name: 'Legacy provider' }); cm.saveCurlProvider(provider);
    const before = e.snapshot(); e.state.decryptDenied = true; cm = e.manager();
    assert.equal(cm.isCredentialStoreDegraded(), true);
    const api = e.ipc(cm);
    for (const result of [await api.save({ ...provider, name: 'Rejected edit' }), await api.delete(provider.id)]) {
      assert.equal(result.success, false); assert.equal(result.error, 'credential_store_degraded');
    }
    await assert.rejects(api.read(), /credential store.*unavailable|Could not load custom providers/i);
    assert.deepEqual(api.events, [], 'failed writes cannot refresh routing or emit a saved-state broadcast');
    assert.deepEqual(e.snapshot(), before);
    e.state.decryptDenied = false; cm = e.manager();
    assert.deepEqual(plain(cm.getCurlProviders()), [provider]);
    assert.equal(cm.getCustomProviders()[0].name, 'Legacy provider');
  });

  for (const action of ['insert', 'update', 'delete']) test(`${platform}: disk-denied ${action} rolls back memory and both provider stores`, async t => {
    const e = env(t, platform); const cm = e.manager();
    cm.saveCustomProvider({ ...provider, name: 'Legacy provider' }); cm.saveCurlProvider(provider);
    const beforeDisk = e.snapshot(); const beforeMemory = plain(cm.credentials); e.denyDisk();
    const api = e.ipc(cm);
    const result = action === 'delete' ? await api.delete(provider.id)
      : await api.save({ ...provider, id: action === 'insert' ? 'new-id' : provider.id, name: 'Rejected change' });
    assert.equal(result.success, false); assert.equal(result.error, 'credential_persistence_failed');
    assert.deepEqual(plain(cm.credentials), beforeMemory);
    assert.deepEqual(e.snapshot(), beforeDisk);
    assert.deepEqual(api.events, []);
    assert.deepEqual(plain(await api.read()), [provider, { ...provider, name: 'Legacy provider' }]);
    assert.deepEqual(plain(e.manager().credentials), beforeMemory, 'failed changes cannot appear on restart');
  });

  test(`${platform}: custom and curl manager mutators report failure and restore exact prior state`, t => {
    const e = env(t, platform); const cm = e.manager();
    cm.saveCurlProvider(provider); cm.saveCustomProvider(provider);
    const before = cm.credentials; e.denyDisk();
    for (const [method, arg] of [['saveCurlProvider', { ...provider, name: 'Edit' }], ['saveCustomProvider', { ...provider, name: 'Edit' }], ['deleteCurlProvider', provider.id], ['deleteCustomProvider', provider.id]]) {
      assert.equal(cm[method](arg), false, method);
      assert.equal(cm.credentials, before, 'restore the original object, not a mutated alias');
    }
  });

  test(`${platform}: deletion persists both duplicate-id stores in one transaction`, async t => {
    const e = env(t, platform); const cm = e.manager();
    cm.saveCurlProvider(provider); cm.saveCustomProvider(provider);
    cm.saveCurlProvider({ ...provider, id: 'keep' });
    let writes = 0; const persist = cm.saveCredentials.bind(cm);
    cm.saveCredentials = () => { writes++; return persist(); };
    const api = e.ipc(cm); const result = await api.delete(provider.id);
    assert.equal(result.success, true); assert.equal(writes, 1, 'no half-deleted legacy/curl state');
    assert.deepEqual(api.events, ['refresh', 'broadcast']);
    assert.deepEqual(plain(await api.read()), [{ ...provider, id: 'keep' }]);
    const restarted = e.manager(); assert.deepEqual(plain(restarted.getCustomProviders()), []);
    assert.deepEqual(plain(restarted.getCurlProviders()), [{ ...provider, id: 'keep' }]);
  });

  test(`${platform}: OS encryption refusal retains successful encrypted fallback behavior`, async t => {
    const e = env(t, platform); const cm = e.manager(); e.state.encryptDenied = true;
    const api = e.ipc(cm);
    assert.equal((await api.save(provider)).success, true, 'fallback durability is still success');
    const blob = fs.readFileSync(path.join(e.userData, 'credentials.fallback.enc'));
    assert.equal(blob.includes(Buffer.from(provider.curlCommand)), false, 'never plaintext fallback');
    assert.deepEqual(plain(e.manager().getCurlProviders()), [provider]);
  });

  test(`${platform}: thrown reads and mutations never expose credentials or masquerade as an empty list`, async t => {
    const e = env(t, platform); const cm = e.manager();
    for (const method of ['getCurlProviders', 'saveCurlProvider', 'deleteConfiguredCustomProvider', 'deleteCurlProvider', 'deleteCustomProvider']) {
      cm[method] = () => { throw new Error('PRIVATE endpoint/token/path'); };
    }
    const api = e.ipc(cm);
    await assert.rejects(api.read(), error => { assert.doesNotMatch(error.message, /PRIVATE|endpoint\/token\/path/); return true; });
    for (const result of [await api.save(provider), await api.delete(provider.id)]) {
      assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|endpoint\/token\/path/);
    }
    assert.ok(e.logs.every(line => !line.includes('PRIVATE')), 'IPC logs must also omit secret-bearing exceptions');
  });

  test(`${platform}: custom editing never invokes the re-entry escape hatch on an unreadable store`, async t => {
    const e = env(t, platform); let cm = e.manager(); cm.saveCurlProvider(provider);
    const before = e.snapshot(); e.state.decryptDenied = true; cm = e.manager(); cm.reentryRequired = true;
    const api = e.ipc(cm);
    assert.equal(cm.saveCurlProvider({ ...provider, name: 'Partial replacement' }), false);
    assert.equal(cm.deleteConfiguredCustomProvider(provider.id), false);
    assert.equal((await api.save(provider)).error, 'credential_store_degraded');
    assert.equal((await api.delete(provider.id)).error, 'credential_store_degraded');
    assert.deepEqual(e.snapshot(), before, 'preserve recoverable stored providers, not an empty/partial replacement');
  });

  test(`${platform}: an unexpected persistence exception rolls back and is sanitized at IPC`, async t => {
    const e = env(t, platform); const cm = e.manager(); cm.saveCurlProvider(provider); cm.saveCustomProvider(provider);
    const before = cm.credentials; const disk = e.snapshot();
    cm.saveCredentials = () => { throw new Error('PRIVATE endpoint/token/path'); };
    const api = e.ipc(cm);
    for (const result of [await api.save({ ...provider, name: 'Rejected' }), await api.delete(provider.id)]) {
      assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      assert.equal(cm.credentials, before); assert.deepEqual(e.snapshot(), disk);
    }
  });

  test(`${platform}: legacy cURL IPC aliases report denied persistence and reject degraded reads`, async t => {
    const e = env(t, platform); let cm = e.manager(); cm.saveCurlProvider(provider);
    const before = e.snapshot(); e.denyDisk(); let api = e.ipc(cm);
    assert.equal((await api.saveCurl({ ...provider, name: 'Rejected' })).success, false);
    assert.equal((await api.deleteCurl(provider.id)).success, false);
    assert.deepEqual(plain(await api.readCurl()), [provider]); assert.deepEqual(e.snapshot(), before);
    e.state.decryptDenied = true; cm = e.manager(); api = e.ipc(cm);
    assert.equal((await api.saveCurl(provider)).error, 'credential_store_degraded');
    assert.equal((await api.deleteCurl(provider.id)).error, 'credential_store_degraded');
    await assert.rejects(api.readCurl(), /Could not load custom providers/);
  });

  test(`${platform}: invalid payload or deletion id never mutates credentials`, async t => {
    const e = env(t, platform); const cm = e.manager(); cm.saveCurlProvider(provider);
    const before = e.snapshot(); const api = e.ipc(cm);
    assert.equal((await api.save({ ...provider, curlCommand: 'no placeholder' })).success, false);
    assert.equal((await api.delete(null)).success, false); assert.equal((await api.deleteCurl('')).success, false);
    assert.deepEqual(e.snapshot(), before); assert.deepEqual(api.events, []);
  });

  test(`${platform}: read-back preserves array contract; post-save runtime failures remain sanitized`, async t => {
    const e = env(t, platform); const cm = e.manager(); const api = e.ipc(cm);
    assert.deepEqual(plain(await api.read()), [], 'healthy fresh store is legitimately empty');
    assert.equal((await api.save(provider)).success, true);
    const updated = await api.read(); assert.ok(Array.isArray(updated));
    assert.deepEqual(plain(updated), [provider]);
    const result = await e.ipc(cm, { runtimeDenied: true }).save({ ...provider, name: 'Durable edit' });
    // Runtime refresh is outside the persistence contract; a failure must at
    // least be sanitized, and stored providers must remain durably intact.
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.equal(e.manager().getCurlProviders()[0].name, 'Durable edit');
  });
}
