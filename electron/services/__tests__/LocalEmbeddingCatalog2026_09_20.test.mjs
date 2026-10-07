// electron/services/__tests__/LocalEmbeddingCatalog2026_09_20.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const catalogModulePath = path.join(repoRoot, 'dist-electron/electron/rag/embeddingModelCatalog.js');
const installerModulePath = path.join(repoRoot, 'dist-electron/electron/services/embeddings/localEmbeddingModelInstaller.js');
const identityModulePath = path.join(repoRoot, 'dist-electron/electron/rag/embeddingConfigIdentity.js');
const resolverModulePath = path.join(repoRoot, 'dist-electron/electron/rag/EmbeddingProviderResolver.js');

const {
  EMBEDDING_MODEL_CATALOG,
  findEmbeddingCatalogModel,
  listEmbeddingCatalogModels,
} = await import(pathToFileURL(catalogModulePath).href);

const {
  statusOf,
  listEmbeddingCatalogStatus,
  resolveEmbeddingModelPath,
  revealLocalEmbeddingModelsDirectory,
} = await import(pathToFileURL(installerModulePath).href);

const {
  embeddingConfigFrom,
  embeddingConfigChanged,
} = await import(pathToFileURL(identityModulePath).href);

const {
  EmbeddingProviderResolver,
} = await import(pathToFileURL(resolverModulePath).href);

describe('Local Embedding Model Catalog (2026-09-20)', () => {
  test('catalog contains the requested models', () => {
    const ids = EMBEDDING_MODEL_CATALOG.map((m) => m.id);
    const expected = [
      'minilm-l6-v2',
      'bge-small-en-v1.5',
      'qwen3-embedding-0.6b-q4',
      'qwen3-embedding-4b-q4',
      'jina-embeddings-v4-q4',
      'jina-embeddings-v5-text-small',
      'jina-code-embeddings-0.5b',
      'jina-code-embeddings-1.5b-q4',
    ];
    for (const exp of expected) {
      assert.ok(ids.includes(exp), `Catalog missing expected model: ${exp}`);
    }
  });

  test('all catalog models declare valid parameters, dimensions, and licenses', () => {
    for (const m of EMBEDDING_MODEL_CATALOG) {
      assert.ok(m.id && typeof m.id === 'string', `${m.id} has valid id`);
      assert.ok(m.name && typeof m.name === 'string', `${m.id} has valid name`);
      assert.ok(m.dimensions > 0, `${m.id} has positive dimensions: ${m.dimensions}`);
      assert.ok(m.bytes > 0, `${m.id} has positive byte size`);
      assert.ok(m.files.length > 0, `${m.id} declares files`);
      assert.ok(m.license && m.license.spdx, `${m.id} declares license`);
      assert.ok(m.runtime === 'onnx' || m.runtime === 'gguf', `${m.id} valid runtime`);
      assert.equal(m.supported, true, `${m.id} is supported on this platform`);
    }
  });

  test('findEmbeddingCatalogModel retrieves models by id', () => {
    const qwen = findEmbeddingCatalogModel('qwen3-embedding-0.6b-q4');
    assert.ok(qwen);
    assert.equal(qwen.runtime, 'gguf');
    assert.equal(qwen.dimensions, 1024);

    const bge = findEmbeddingCatalogModel('bge-small-en-v1.5');
    assert.ok(bge);
    assert.equal(bge.runtime, 'onnx');
    assert.equal(bge.dimensions, 384);
  });

  test('the bundled model (multilingual-e5-small since 2026-09-22) is marked bundled and discovers packaged resources', () => {
    const bundled = findEmbeddingCatalogModel('multilingual-e5-small');
    assert.ok(bundled);
    assert.equal(bundled.bundled, true);
    assert.deepEqual(EMBEDDING_MODEL_CATALOG.filter((m) => m.bundled).map((m) => m.id), ['multilingual-e5-small'], 'exactly one bundled entry');

    const status = statusOf(bundled);
    assert.equal(status.state, 'installed');
    assert.equal(status.missing.length, 0);

    const resolved = resolveEmbeddingModelPath(bundled);
    assert.ok(resolved);
    assert.ok(resolved.includes('multilingual-e5-small'));
  });

  test('MiniLM, no longer shipped, is an ordinary download', () => {
    const minilm = findEmbeddingCatalogModel('minilm-l6-v2');
    assert.ok(minilm);
    assert.notEqual(minilm.bundled, true);
  });

  test('listEmbeddingCatalogStatus maps status for all catalog models', () => {
    const statusList = listEmbeddingCatalogStatus();
    assert.equal(statusList.length, EMBEDDING_MODEL_CATALOG.length);
    const bundledStatus = statusList.find((m) => m.id === 'multilingual-e5-small');
    assert.ok(bundledStatus);
    assert.equal(bundledStatus.status.state, 'installed');
  });

  test('all catalog models declare realistic context length values', () => {
    for (const m of EMBEDDING_MODEL_CATALOG) {
      assert.ok(typeof m.contextLength === 'number' && m.contextLength >= 256, `${m.id} has contextLength >= 256`);
    }
    assert.equal(findEmbeddingCatalogModel('minilm-l6-v2').contextLength, 256);
    assert.equal(findEmbeddingCatalogModel('bge-small-en-v1.5').contextLength, 512);
    assert.equal(findEmbeddingCatalogModel('qwen3-embedding-0.6b-q4').contextLength, 8192);
    assert.equal(findEmbeddingCatalogModel('jina-embeddings-v4-q4').contextLength, 8192);
  });

  test('revealLocalEmbeddingModelsDirectory is callable and resolves safely', async () => {
    const ok = await revealLocalEmbeddingModelsDirectory();
    assert.ok(typeof ok === 'boolean');
  });
});

describe('Local Embedding Model Activation Probe', () => {
  const source = readFileSync(path.join(repoRoot, 'electron/ipcHandlers.ts'), 'utf8');
  const start = source.indexOf("  safeHandle('embedding:use-local-model'");
  assert.ok(start >= 0, 'local-model activation handler exists');
  const end = source.indexOf('\n  });', start);
  assert.ok(end > start, 'local-model activation handler closes');
  const handlerCode = transformSync(source.slice(start, end + '\n  });'.length), { loader: 'ts' }).code;

  async function probeFailure(error) {
    let handler;
    let disposed = false;
    const logged = [];
    const settings = {
      get: () => null,
      set: () => { throw new Error('Probe failure must not change settings'); },
    };
    const modules = {
      './services/SettingsManager': { SettingsManager: { getInstance: () => settings } },
      './rag/embeddingModelCatalog': { findEmbeddingCatalogModel: () => ({ name: 'Qwen3 Embedding', supported: true, dimensions: 1024 }) },
      './services/embeddings/localEmbeddingModelInstaller': { statusOf: () => ({ state: 'installed' }) },
      './rag/providers/LocalEmbeddingProvider': { LocalEmbeddingProvider: class {
        async embed() { throw error; }
        async dispose() { disposed = true; }
      } },
    };
    new Function('safeHandle', 'require', 'LOCAL_EMBEDDING_PROBE_SLOT_WAIT_MS', 'console', handlerCode)(
      (_channel, fn) => { handler = fn; },
      (name) => { assert.ok(modules[name], `unexpected import ${name}`); return modules[name]; },
      100,
      { error: (...args) => logged.push(args) },
    );
    const result = await handler(null, 'qwen3-embedding-0.6b-q4');
    assert.equal(disposed, true, 'failed probe releases its provider');
    return { result, logged };
  }

  test('missing chalk in the packaged llama runtime advises repairing the app, not the model', async () => {
    const errors = [
      new Error("Cannot find package 'chalk' imported from C:\\Users\\Jane\\AppData\\Local\\Natively\\app.asar.unpacked\\node_modules\\node-llama-cpp\\dist\\index.js"),
      new Error("Cannot find module 'chalk' imported from /Users/jane/Library/Application Support/Natively/node_modules/node-llama-cpp/dist/index.js"),
      Object.assign(new Error('Packaged runtime dependency unavailable'), { code: 'MODULE_NOT_FOUND' }),
    ];
    for (const error of errors) {
      const { result, logged } = await probeFailure(error);
      assert.equal(result.error, 'validation_failed');
      assert.match(result.message, /reinstall or update the app/i);
      assert.doesNotMatch(result.message, /corrupt|re-download|C:\\Users|\/Users\/jane/i);
      assert.ok(logged.some((args) => args.includes(error)), 'original error remains available in diagnostics');
    }
  });

  test('invalid GGUF weights retain model repair guidance', async () => {
    const { result } = await probeFailure(new Error('Failed to load GGUF model: invalid magic bytes'));
    assert.equal(result.error, 'validation_failed');
    assert.match(result.message, /invalid magic bytes/);
    assert.match(result.message, /re-downloading/i);
    assert.doesNotMatch(result.message, /reinstall or update the app/i);
  });

  test('occupied ONNX slots retain the busy response', async () => {
    const { result } = await probeFailure(new Error('No ONNX session slot became free'));
    assert.equal(result.error, 'busy');
    assert.match(result.message, /Try again in a moment/);
  });
});

describe('Local Embedding Identity and Resolver', () => {
  test('embeddingConfigFrom carries localEmbeddingModelId', () => {
    const cfg = embeddingConfigFrom({
      embeddingMode: 'manual',
      embeddingProvider: 'local',
      localEmbeddingModelId: 'qwen3-embedding-0.6b-q4',
    });
    assert.equal(cfg.localEmbeddingModelId, 'qwen3-embedding-0.6b-q4');
  });

  test('embeddingConfigChanged detects changes to localEmbeddingModelId', () => {
    const prev = { localEmbeddingModelId: 'minilm-l6-v2' };
    const next = { localEmbeddingModelId: 'qwen3-embedding-0.6b-q4' };
    assert.equal(embeddingConfigChanged(prev, next), true);

    const same = { localEmbeddingModelId: 'qwen3-embedding-0.6b-q4' };
    assert.equal(embeddingConfigChanged(next, same), false);
  });

  test('EmbeddingProviderResolver constructs LocalEmbeddingProvider with configured modelId', async () => {
    const res = await EmbeddingProviderResolver.resolve({
      embeddingMode: 'manual',
      embeddingProvider: 'local',
      localEmbeddingModelId: 'bge-small-en-v1.5',
    });
    assert.equal(res.name, 'local');
    assert.equal(res.catalogId, 'bge-small-en-v1.5');
    assert.equal(res.dimensions, 384);
  });
});
