// Executes the current renderer callbacks in memory; never emits or replaces
// source files. IPC is the substituted boundary, not a duplicate of UI logic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const modeFile = path.join(root, 'premium/src/ModesSettings.tsx');
const profileFile = path.join(root, 'src/components/ProfileIntelligenceSettings.tsx');
const hasModesEditor = fs.existsSync(modeFile);
const artifactFiles = ['ModesSettings.persistence.patch.txt', 'README.md']
  .map((name) => path.join(root, 'patches/local-premium', name));
const sourceFiles = [profileFile, path.join(root, 'src/premium/index.tsx'), ...(hasModesEditor ? [modeFile] : []),
  ...artifactFiles.filter((file) => fs.existsSync(file))];
const sourceSnapshots = sourceFiles.map((file) => [file, fs.readFileSync(file)]);
after(() => {
  for (const [file, before] of sourceSnapshots) assert.deepEqual(fs.readFileSync(file), before, `${file}: tests must never replace source files`);
});

function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  return { source, ast: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) };
}

function evaluate(source, context) {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  return vm.runInNewContext(code, context);
}

function modesHarness(platform, overrides = {}) {
  const { ast } = parse(modeFile);
  const names = new Set(['api', 'refreshModes', 'handleSavePrompt', 'handleDuplicate']);
  const declarations = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'safeGet') declarations.push(node.getText(ast));
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, 5);
  const original = { id: 'original', name: 'Original', templateType: 'general', customContext: 'Original prompt' };
  const state = { error: null, selectedId: original.id, modes: [original], activeMode: original, reads: 0 };
  const api = {
    modesGetAll: async () => { state.reads++; return state.modes; },
    modesGetActive: async () => state.activeMode,
    modesUpdate: async () => ({ success: false, error: 'write_refused' }),
    modesCreate: async () => {
      state.modes = [...state.modes, { ...original, id: 'copy', customContext: '' }];
      return { success: true, mode: { id: 'copy' } };
    },
    ...overrides,
  };
  const callbacks = evaluate(`(() => { ${declarations.join('\n')} return { handleSavePrompt, handleDuplicate }; })()`, {
    window: { electronAPI: api }, process: { platform }, console,
    useCallback: (fn) => fn,
    setError: (value) => { state.error = value; },
    setModes: (value) => { state.modes = value; },
    setActiveMode: (value) => { state.activeMode = value; },
    setSelectedId: (value) => { state.selectedId = typeof value === 'function' ? value(state.selectedId) : value; },
    setLoading: () => {},
  });
  return { state, original, ...callbacks };
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: failed prompt save keeps its error and does not rehydrate over the draft`, { skip: !hasModesEditor }, async () => {
    const h = modesHarness(platform);
    await h.handleSavePrompt('original', 'Edited prompt');
    assert.equal(h.state.error, 'write_refused');
    assert.equal(h.state.reads, 0);
  });

  test(`${platform}: rejected prompt save is displayed, not an unhandled rejection`, { skip: !hasModesEditor }, async () => {
    const h = modesHarness(platform, { modesUpdate: async () => { throw new Error('IPC disconnected'); } });
    await h.handleSavePrompt('original', 'Edited prompt');
    assert.match(h.state.error, /IPC disconnected/);
    assert.equal(h.state.reads, 0);
  });

  test(`${platform}: successful prompt save rehydrates persisted state`, { skip: !hasModesEditor }, async () => {
    const h = modesHarness(platform, { modesUpdate: async () => ({ success: true }) });
    await h.handleSavePrompt('original', 'Edited prompt');
    assert.equal(h.state.error, null);
    assert.equal(h.state.reads, 1);
  });

  for (const rejected of [false, true]) {
    test(`${platform}: duplicate reports ${rejected ? 'rejected' : 'refused'} prompt copy and keeps original selected`, { skip: !hasModesEditor }, async () => {
      const h = modesHarness(platform, { modesUpdate: async () => {
        if (rejected) throw new Error('copy write failed');
        return { success: false, error: 'copy write failed' };
      } });
      await h.handleDuplicate(h.original);
      assert.equal(h.state.selectedId, 'original');
      assert.match(h.state.error, /copy write failed/);
      assert.match(h.state.error, /created|partial|incomplete/i, 'acknowledge that the new mode exists without its prompt');
    });
  }

  test(`${platform}: successful duplicate selects the copy`, { skip: !hasModesEditor }, async () => {
    const h = modesHarness(platform, { modesUpdate: async () => ({ success: true }) });
    await h.handleDuplicate(h.original);
    assert.equal(h.state.selectedId, 'copy');
    assert.equal(h.state.error, null);
  });
}

function profileHarness(platform, action, outcome) {
  const { ast } = parse(profileFile);
  let callback;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick'
      && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const text = node.initializer.expression.getText(ast);
      if (text.includes(`?.${action}?.(`)) callback = text;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, `production ${action} callback exists`);
  const originalData = { identity: { name: 'Existing profile' }, hasActiveJD: true, activeJD: { company: 'Existing company' } };
  const originalDossier = { company: 'Existing company' };
  const state = {
    status: { hasProfile: true, profileMode: false }, data: originalData, dossier: originalDossier,
    profileError: '', jdError: '', reads: 0, toggleArmed: false,
  };
  const nextData = action === 'profileDelete'
    ? { hasActiveJD: true, activeJD: originalData.activeJD }
    : { identity: originalData.identity, hasActiveJD: false };
  const api = {
    [action]: async () => {
      if (outcome === 'rejected') throw new Error('IPC disconnected');
      return outcome === 'missing' ? undefined : { success: outcome === 'success', error: 'write_refused' };
    },
    profileGetProfile: async () => { state.reads++; return nextData; },
  };
  const click = evaluate(`(${callback})`, {
    window: { electronAPI: api }, process: { platform },
    profileStatus: state.status, hasProfileAccess: true, profileUploading: false, jdUploading: false,
    askConfirm: async () => true,
    piToggleInit: { arm: () => { state.toggleArmed = true; } },
    setProfileStatus: (value) => { state.status = typeof value === 'function' ? value(state.status) : value; },
    setProfileData: (value) => { state.data = value; },
    setCompanyDossier: (value) => { state.dossier = value; },
    setProfileError: (value) => { state.profileError = value; },
    setJdError: (value) => { state.jdError = value; },
  });
  return { click, state, originalData, originalDossier, nextData };
}

for (const platform of ['darwin', 'win32']) {
  for (const action of ['profileSetMode', 'profileDelete', 'profileDeleteJD']) {
    for (const outcome of ['refused', 'rejected', 'missing']) {
      test(`${platform}: ${action} ${outcome} preserves documents/state and displays failure`, async () => {
        const h = profileHarness(platform, action, outcome);
        await h.click();
        assert.equal(h.state.status.hasProfile, true);
        assert.equal(h.state.status.profileMode, false);
        assert.equal(h.state.data, h.originalData);
        assert.equal(h.state.dossier, h.originalDossier);
        assert.equal(h.state.reads, 0);
        assert.equal(h.state.toggleArmed, false);
        const error = action === 'profileDeleteJD' ? h.state.jdError : h.state.profileError;
        assert.ok(error, 'failure must be shown in the existing error slot');
        if (outcome !== 'missing') assert.match(error, outcome === 'rejected' ? /IPC disconnected/ : /write_refused/);
      });
    }

    test(`${platform}: ${action} success updates local state`, async () => {
      const h = profileHarness(platform, action, 'success');
      await h.click();
      if (action === 'profileSetMode') {
        assert.equal(h.state.status.profileMode, true);
        assert.equal(h.state.toggleArmed, true);
      } else {
        assert.equal(h.state.data, h.nextData);
        assert.equal(h.state.reads, 1);
        if (action === 'profileDelete') assert.equal(h.state.status.hasProfile, false);
        else assert.equal(h.state.dossier, null);
      }
      assert.equal(h.state.profileError, '');
      assert.equal(h.state.jdError, '');
    });
  }
}

test('present premium editor resolves through the real loader without modifying the scaffold', { skip: !hasModesEditor }, () => {
  const before = fs.readFileSync(modeFile);
  const mod = { exports: {} };
  evaluate(before.toString(), { module: mod, exports: mod.exports, require, console });
  const { ast } = parse(path.join(root, 'src/premium/index.tsx'));
  const get = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'get');
  let initializer;
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(ast) === 'ModesSettings') initializer = declaration.initializer.getText(ast);
      }
    }
  }
  assert.ok(get && initializer);
  const fallback = () => null;
  const loaded = evaluate(`(() => { ${get.getText(ast)} return ${initializer}; })()`, {
    _modesSettings: { editor: mod.exports }, NullComponent: fallback,
  });
  assert.notEqual(loaded, fallback);
  assert.equal(loaded, mod.exports.ModesSettings);
  assert.deepEqual(fs.readFileSync(modeFile), before, 'transpilation and module evaluation must never write source files');
});
