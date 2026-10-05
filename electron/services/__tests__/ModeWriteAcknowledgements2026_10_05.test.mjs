// Run with ELECTRON_RUN_AS_NODE=1 electron --test (better-sqlite3's ABI).
// AST extraction executes the current public methods/handlers without starting
// the app, migrating user data, rebuilding bundles or replacing source files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const quietConsole = { log() {}, warn() {}, error() {} };
const sourceFiles = ['electron/db/DatabaseManager.ts', 'electron/services/ModesManager.ts', 'electron/ipcHandlers.ts'];
const sourceSnapshots = sourceFiles.map((file) => [file, fs.readFileSync(path.join(root, file))]);
after(() => {
  for (const [file, before] of sourceSnapshots) assert.deepEqual(fs.readFileSync(path.join(root, file)), before, `${file}: tests must never replace source files`);
});
const parse = (file) => ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
const dbAst = parse('electron/db/DatabaseManager.ts');
const managerAst = parse('electron/services/ModesManager.ts');
const ipcAst = parse('electron/ipcHandlers.ts');

function evaluate(source, context) {
  return vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
}

function methods(ast, className, names) {
  const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  const selected = declaration.members.filter((node) => node.name && names.includes(node.name.getText(ast)));
  assert.equal(selected.length, names.length);
  return selected.map((node) => node.getText(ast)).join('\n');
}

const DatabaseManager = evaluate(`(class DatabaseManager {
  constructor(db) { this.db = db; }
  ${methods(dbAst, 'DatabaseManager', ['createMode', 'updateMode', 'setActiveMode', 'getModes', 'getActiveMode'])}
})`, { console: quietConsole });

function setup(t, filename = ':memory:') {
  const sqlite = new SQLite(filename);
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE modes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, template_type TEXT NOT NULL,
    custom_context TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 0,
    source_contract_json TEXT, is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '2026-10-05T00:00:00.000Z'
  )`);
  const database = new DatabaseManager(sqlite);
  for (const id of ['a', 'b']) database.createMode({ id, name: id.toUpperCase(), templateType: 'general', customContext: `${id} prompt` });
  database.setActiveMode('a');
  return { sqlite, database };
}

function failWrites(sqlite, kind) {
  const clauses = {
    create: "BEFORE INSERT ON modes BEGIN SELECT RAISE(ABORT, 'create write refused'); END",
    prompt: "BEFORE UPDATE OF custom_context ON modes BEGIN SELECT RAISE(ABORT, 'prompt write refused'); END",
    activate: "BEFORE UPDATE OF is_active ON modes WHEN NEW.is_active = 1 BEGIN SELECT RAISE(ABORT, 'activation write refused'); END",
  };
  sqlite.exec(`CREATE TRIGGER refuse_write ${clauses[kind]}`);
}

for (const method of ['createMode', 'updateMode', 'setActiveMode']) {
  test(`${method}: unavailable store throws instead of acknowledging a no-op`, () => {
    const database = new DatabaseManager(null);
    const args = method === 'createMode' ? [{ id: 'c', name: 'C', templateType: 'general', customContext: '' }]
      : method === 'updateMode' ? ['a', { name: 'Changed' }] : ['b'];
    assert.throws(() => database[method](...args), /not initialized|unavailable/i);
  });
}

test('createMode propagates SQLite insertion failure without creating a phantom mode', (t) => {
  const { sqlite, database } = setup(t);
  failWrites(sqlite, 'create');
  assert.throws(() => database.createMode({ id: 'c', name: 'C', templateType: 'general', customContext: '' }), /create write refused/);
  assert.equal(database.getModes().some((row) => row.id === 'c'), false);
});

test('updateMode propagates failure and rolls back all fields in the save', (t) => {
  const { sqlite, database } = setup(t);
  failWrites(sqlite, 'prompt');
  assert.throws(() => database.updateMode('a', { name: 'Changed name', customContext: 'Changed prompt' }), /prompt write refused/);
  assert.equal(database.getActiveMode().name, 'A');
  assert.equal(database.getActiveMode().custom_context, 'a prompt');
});

test('updateMode rejects a missing target rather than reporting an unsaved edit', (t) => {
  const { database } = setup(t);
  assert.throws(() => database.updateMode('missing', { customContext: 'Changed prompt' }), /not found/i);
});

for (const target of ['missing', '']) {
  test(`setActiveMode rejects ${JSON.stringify(target)} and retains the prior active mode`, (t) => {
    const { database } = setup(t);
    assert.throws(() => database.setActiveMode(target), /not found|invalid/i);
    assert.equal(database.getActiveMode().id, 'a');
  });
}

test('setActiveMode propagates SQLite failure and rolls back clearing the old active flag', (t) => {
  const { sqlite, database } = setup(t);
  failWrites(sqlite, 'activate');
  assert.throws(() => database.setActiveMode('b'), /activation write refused/);
  assert.equal(database.getActiveMode().id, 'a');
  assert.equal(database.getModes().filter((row) => row.is_active === 1).length, 1);
});

test('successful mode writes survive reopen, and explicit null clears activation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode persistence ü '));
  const filename = path.join(dir, 'modes.sqlite');

  const { sqlite, database } = setup(t, filename);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  database.updateMode('b', { name: 'Saved B', customContext: 'Saved prompt' });
  database.setActiveMode('b');
  sqlite.close();
  const reopened = new SQLite(filename);
  t.after(() => reopened.close());
  const hydrated = new DatabaseManager(reopened);
  assert.equal(hydrated.getActiveMode().id, 'b');
  assert.equal(hydrated.getActiveMode().name, 'Saved B');
  assert.equal(hydrated.getActiveMode().custom_context, 'Saved prompt');
  hydrated.setActiveMode(null);
  assert.equal(hydrated.getActiveMode(), null);
  reopened.close();
});

function managerHarness(database) {
  const ModeManager = evaluate(`(class ModesManager {
    ${methods(managerAst, 'ModesManager', ['createMode', 'updateMode', 'setActiveMode', '_cache', 'invalidateActiveModeCache', 'isKnownTemplateType'])}
  })`, {
    DatabaseManager: { getInstance: () => database },
    ACTIVE_MODE_CACHE_KEY: '__nativelyActiveModeInfoCacheV1__',
    PROFILE_OKF_RESERVED_MODE_ID: '__profile_okf__',
    MODE_TEMPLATES: [{ type: 'general' }], TEMPLATE_NOTE_SECTIONS: {},
    defaultSourceContractForNewMode: () => ({ origin: 'default_new_mode' }),
    serializeModeSourceContract: JSON.stringify, crypto, console: quietConsole,
  });
  const manager = new ModeManager();
  let compiled = 0;
  manager.compileAllSectionsAsync = () => { compiled++; };
  manager.getModes = () => database.getModes().filter((row) => row.template_type !== '__reserved__').map((row) => ({
    id: row.id, name: row.name, templateType: row.template_type, customContext: row.custom_context,
  }));
  manager.getActiveMode = () => {
    const active = database.getActiveMode();
    return active ? manager.getModes().find((mode) => mode.id === active.id) : null;
  };
  manager.getReferenceFileIndexStatuses = () => [];
  manager.prewarmModeReferenceIndex = async () => {};
  const cached = { id: 'a', name: 'A' };
  ModeManager._cache.info = cached;
  ModeManager._cache.valid = true;
  return { manager, cache: ModeManager._cache, cached, compiled: () => compiled };
}

function ipcHandler(channel, manager, platform = 'win32', pro = true) {
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ipcAst) === 'safeHandle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) callback = node.arguments[1].getText(ipcAst);
    ts.forEachChild(node, visit);
  }
  visit(ipcAst);
  assert.ok(callback, `${channel} handler exists`);
  const effects = [];
  const intelligence = {
    clearSessionContext: () => effects.push('clear-session'),
    supersedeLiveAnswers: () => effects.push('supersede-live'),
    setDynamicActionContext: () => effects.push('dynamic-context'),
    clearDynamicActionContext: () => effects.push('clear-dynamic-context'),
  };
  const modules = {
    './services/ModesManager': { ModesManager: { getInstance: () => manager } },
    './services/chatStreamRegistry': { abortAndInvalidateChatStreams: () => effects.push('abort-streams') },
    './context-intelligence/question/conversation-state-store': { clearConversationState: () => effects.push('clear-v3') },
    './services/telemetry/TelemetryService': { telemetryService: { track: () => effects.push('telemetry') } },
  };
  const handler = evaluate(`(${callback})`, {
    require: (id) => { assert.ok(modules[id], `unexpected dependency: ${id}`); return modules[id]; },
    isProOrTrialActive: () => pro,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
      send: (event, payload) => effects.push({ event, payload }),
    } }] },
    appState: { getIntelligenceManager: () => intelligence, applyAutoAnswerThresholds: () => effects.push('thresholds') },
    _chatStreamsBySender: new Map(),
    _manualConversationMemory: { clearAllSessions: () => effects.push('clear-manual') },
    _manualCodingState: { clearAllSessions: () => effects.push('clear-coding') },
    process: { platform }, crypto, console: quietConsole,
  });
  return { handler, effects };
}

for (const platform of ['darwin', 'win32']) {
  for (const [channel, kind, args] of [
    ['modes:create', 'create', [{ name: 'C', templateType: 'general' }]],
    ['modes:update', 'prompt', ['a', { customContext: 'Changed prompt' }]],
    ['modes:set-active', 'activate', ['b']],
  ]) {
    test(`${platform}: ${channel} propagates real SQLite failure without cache/broadcast/session changes`, async (t) => {
      const { database, sqlite } = setup(t);
      const h = managerHarness(database);
      failWrites(sqlite, kind);
      const { handler, effects } = ipcHandler(channel, h.manager, platform);
      const result = await handler({}, ...args);
      assert.equal(result.success, false);
      assert.match(result.error, /write refused/);
      assert.equal(database.getActiveMode().id, 'a');
      assert.equal(h.cache.valid, true);
      assert.equal(h.cache.info, h.cached);
      assert.equal(h.compiled(), 0);
      assert.deepEqual(effects, []);
    });
  }

  test(`${platform}: successful activation invalidates cache, clears sessions and broadcasts the saved mode`, async (t) => {
    const { database } = setup(t);
    const h = managerHarness(database);
    const { handler, effects } = ipcHandler('modes:set-active', h.manager, platform);
    assert.equal((await handler({}, 'b')).success, true);
    assert.equal(database.getActiveMode().id, 'b');
    assert.equal(h.cache.valid, false);
    assert.equal(h.cache.info, null);
    assert.ok(effects.includes('abort-streams'));
    assert.ok(effects.includes('clear-session'));
    assert.equal(effects.find((entry) => entry.event === 'mode-changed').payload.id, 'b');
  });

  for (const target of ['missing', '__profile_okf__']) {
    test(`${platform}: activation of ${target} fails without invalidation or a lying broadcast`, async (t) => {
      const { database, sqlite } = setup(t);
      sqlite.prepare('INSERT INTO modes (id, name, template_type) VALUES (?, ?, ?)').run('__profile_okf__', 'Reserved', '__reserved__');
      const h = managerHarness(database);
      const { handler, effects } = ipcHandler('modes:set-active', h.manager, platform);
      const result = await handler({}, target);
      assert.equal(result.success, false);
      assert.equal(database.getActiveMode().id, 'a');
      assert.equal(h.cache.valid, true);
      assert.deepEqual(effects, []);
    });
  }
}
