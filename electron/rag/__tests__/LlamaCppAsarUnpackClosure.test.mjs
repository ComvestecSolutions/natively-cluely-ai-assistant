import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const unpack = pkg.build.asarUnpack;

function installedLlamaDependencies() {
  const found = new Map();
  function visit(name, from, optional = false) {
    let dir = from;
    let manifest;
    while (dir.startsWith(repoRoot)) {
      const candidate = path.join(dir, 'node_modules', name, 'package.json');
      if (fs.existsSync(candidate)) { manifest = candidate; break; }
      if (dir === repoRoot) break;
      dir = path.dirname(dir);
    }
    if (!manifest) {
      if (optional) return;
      assert.fail(`missing installed node-llama-cpp runtime dependency: ${name}`);
    }
    if (found.has(manifest)) return;
    found.set(manifest, name);
    const dependency = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const child of Object.keys(dependency.dependencies ?? {})) visit(child, path.dirname(manifest));
    for (const child of Object.keys(dependency.optionalDependencies ?? {})) visit(child, path.dirname(manifest), true);
  }
  visit('node-llama-cpp', repoRoot);
  return [...found.values()];
}

test('both GGUF workers load node-llama-cpp from the unpacked worker path', () => {
  for (const rel of [
    'electron/rag/providers/localEmbeddingWorker.ts',
    'electron/rag/ggufRerankerWorker.ts',
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.match(source, /import\("node-llama-cpp"\)/, `${rel} must load the llama package`);
  }
  for (const file of ['localEmbeddingWorker.js', 'ggufRerankerWorker.js']) {
    assert.ok(unpack.includes(`**/${file}`), `${file} must run from app.asar.unpacked`);
  }
  assert.ok(pkg.dependencies['node-llama-cpp'], 'node-llama-cpp must ship as a production dependency');
});

test('the complete installed node-llama-cpp dependency closure is unpacked', () => {
  const dependencies = installedLlamaDependencies();
  assert.ok(dependencies.includes('chalk'), 'probe sanity: llama depends on chalk');
  const missing = dependencies.filter((name) => !unpack.includes(`**/node_modules/${name}/**`)
    && !unpack.includes(`**/node_modules/${name.split('/')[0]}/**`));
  assert.deepEqual([...new Set(missing)].sort(), [],
    'unpacked GGUF workers cannot resolve packages left in app.asar; unpack the complete runtime closure');
  // Optional native packages are OS-specific: the Windows install cannot walk macOS
  // binaries (or vice versa), so require platform-neutral patterns for both.
  for (const scope of ['@node-llama-cpp', '@reflink']) {
    assert.ok(unpack.includes(`**/node_modules/${scope}/**`), `${scope} must cover both macOS and Windows binaries`);
  }
  assert.ok(!unpack.includes('**/node_modules/**'), 'do not unpack unrelated dependencies');
});

test('the packaged asset gate checks native llama binaries for both supported platforms', () => {
  const gate = fs.readFileSync(path.join(repoRoot, 'scripts/verify-packaged-local-assets.mjs'), 'utf8');
  for (const binary of ['mac-arm64-metal', 'mac-x64', 'win-x64']) {
    assert.ok(gate.includes(`node_modules/@node-llama-cpp/${binary}`),
      `the packaged asset gate must reject a build missing ${binary}`);
  }
  assert.ok(gate.includes('llamaDependencyDirs(unpacked, true)'),
    'the packaged asset gate must traverse packaged transitive dependencies');
});

function packagedFixture(platform, llamaDependencies, llamaOptionalDependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-llama-packaged-'));
  const app = path.join(root, platform === 'darwin' ? 'Natively.app' : 'win-unpacked');
  const resources = path.join(app, ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']));
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const llama = path.join(unpacked, 'node_modules', 'node-llama-cpp');
  fs.mkdirSync(llama, { recursive: true });
  fs.writeFileSync(path.join(llama, 'package.json'), JSON.stringify({
    name: 'node-llama-cpp', version: '3.20.0', main: './dist/index.js',
    dependencies: llamaDependencies,
    optionalDependencies: llamaOptionalDependencies,
  }));
  function put(base, rel, content = 'fixture') {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  put(unpacked, 'node_modules/node-llama-cpp/dist/index.js', 'export const getLlama = () => {};');
  for (const rel of [
    'Xenova/ms-marco-MiniLM-L-6-v2/config.json',
    'Xenova/ms-marco-MiniLM-L-6-v2/tokenizer.json',
    'Xenova/ms-marco-MiniLM-L-6-v2/tokenizer_config.json',
    'Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_quantized.onnx',
    'pipecat-ai/smart-turn-v3/manifest.json',
    'pipecat-ai/smart-turn-v3/smart-turn-v3.1-cpu.onnx',
    ...['manifest.json', 'config.json', 'tokenizer.json', 'tokenizer_config.json',
      'special_tokens_map.json', 'onnx/model_quantized.onnx']
      .map((file) => `Xenova/multilingual-e5-small/${file}`),
  ]) put(path.join(resources, 'models'), rel);
  for (const rel of [
    'dist-electron/electron/rag/providers/localEmbeddingWorker.js',
    'dist-electron/electron/rag/localRerankerWorker.js',
    'dist-electron/electron/rag/ggufRerankerWorker.js',
    'dist-electron/electron/audio/whisper/whisperWorker.js',
    'dist-electron/electron/llm/routing/routerWorker.js',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'node_modules/keytar/build/Release/keytar.node',
  ]) put(unpacked, rel);
  for (const rel of ['node_modules/@huggingface/transformers', 'node_modules/onnxruntime-common',
    'node_modules/onnxruntime-node']) fs.mkdirSync(path.join(unpacked, rel), { recursive: true });
  const nativeNames = platform === 'darwin' ? ['mac-arm64-metal', 'mac-x64'] : ['win-x64'];
  for (const name of nativeNames) {
    const pkgDir = `node_modules/@node-llama-cpp/${name}`;
    put(unpacked, `${pkgDir}/package.json`, JSON.stringify({ name: `@node-llama-cpp/${name}`, main: './dist/index.js' }));
    put(unpacked, `${pkgDir}/dist/index.js`, 'export function getBinsDir() {}');
    put(unpacked, `${pkgDir}/bins/${name}/llama-addon.node`);
    put(unpacked, `${pkgDir}/bins/${name}/_nlcBuildMetadata.json`, '{}');
  }
  if (platform === 'win32') {
    for (const rel of [
      'node_modules/@node-llama-cpp/win-x64/bins/win-x64/ggml-base.dll',
      'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-common.dll',
      'node_modules/sqlite-vec-windows-x64/vec0.dll',
      'native-module/index.win32-x64-msvc.node',
    ]) put(unpacked, rel);
    for (const rel of ['node_modules/onnxruntime-node/bin/napi-v6/win32',
      'node_modules/@img/sharp-win32-x64/lib']) fs.mkdirSync(path.join(unpacked, rel), { recursive: true });
  } else {
    for (const rel of [
      'node_modules/sqlite-vec-darwin-arm64/vec0.dylib',
      'node_modules/sqlite-vec-darwin-x64/vec0.dylib',
      'native-module/index.darwin-arm64.node', 'native-module/index.darwin-x64.node',
    ]) put(unpacked, rel);
    for (const rel of [
      'node_modules/onnxruntime-node/bin/napi-v6/darwin',
      'node_modules/@img/sharp-darwin-arm64/lib',
      'node_modules/@img/sharp-libvips-darwin-arm64/lib',
      'node_modules/@img/sharp-darwin-x64/lib',
      'node_modules/@img/sharp-libvips-darwin-x64/lib',
    ]) fs.mkdirSync(path.join(unpacked, rel), { recursive: true });
    const helper = 'apple-speech/natively-apple-speech';
    put(resources, helper);
    fs.chmodSync(path.join(resources, helper), 0o755);
  }
  return { root, app, unpacked };
}

function checkPackaged(app) {
  const result = spawnSync(process.execPath,
    [path.join(repoRoot, 'scripts/verify-packaged-local-assets.mjs'), '--app', app],
    { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('complete small packaged fixtures pass for Windows and macOS', (t) => {
  for (const platform of ['win32', 'darwin']) {
    const { root, app } = packagedFixture(platform, {});
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = checkPackaged(app);
    assert.equal(result.status, 0, result.output);
  }
});

test('packaged dependency closure comes from the artifact, not installed node_modules', (t) => {
  const { root, app } = packagedFixture('win32', { 'fixture-only-dependency': '1.0.0' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing packaged node-llama-cpp runtime dependency: fixture-only-dependency/);
});

test('installed optional dependencies are traversed from the artifact', (t) => {
  const { root, app, unpacked } = packagedFixture('win32', {}, { 'fixture-optional': '1.0.0' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const optional = path.join(unpacked, 'node_modules', 'fixture-optional');
  fs.mkdirSync(optional, { recursive: true });
  fs.writeFileSync(path.join(optional, 'package.json'), JSON.stringify({
    name: 'fixture-optional', dependencies: { 'fixture-transitive': '1.0.0' },
  }));
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing packaged node-llama-cpp runtime dependency: fixture-transitive/);
});

test('missing chalk fails based on the packaged llama manifest', (t) => {
  const { root, app } = packagedFixture('win32', { chalk: '^5.6.2' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing packaged node-llama-cpp runtime dependency: chalk/);
});

test('an unpacked chalk directory without its entrypoint fails the packaged gate', (t) => {
  const { root, app, unpacked } = packagedFixture('win32', { chalk: '^5.6.2' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chalk = path.join(unpacked, 'node_modules', 'chalk');
  fs.mkdirSync(chalk, { recursive: true });
  fs.writeFileSync(path.join(chalk, 'package.json'), JSON.stringify({ name: 'chalk', main: './source/index.js' }));
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing packaged dependency entrypoint: .*chalk.*source.*index\.js/);
});

test('an empty Windows llama-addon.node fails even when its directory exists', (t) => {
  const { root, app, unpacked } = packagedFixture('win32', {});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(unpacked, 'node_modules', '@node-llama-cpp',
    'win-x64', 'bins', 'win-x64', 'llama-addon.node'), '');
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  assert.match(result.output, /Empty .*llama-addon\.node/);
});

test('empty macOS llama binary fails the packaged gate for either architecture', (t) => {
  const { root, app, unpacked } = packagedFixture('darwin', {});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const arch of ['mac-arm64-metal', 'mac-x64']) {
    fs.writeFileSync(path.join(unpacked, 'node_modules', '@node-llama-cpp',
      arch, 'bins', arch, 'llama-addon.node'), '');
  }
  const result = checkPackaged(app);
  assert.equal(result.status, 1);
  for (const arch of ['mac-arm64-metal', 'mac-x64']) {
    assert.match(result.output, new RegExp(`Empty .*${arch}.*llama-addon\\.node`));
  }
});

test('both macOS release workflows install the two lockfile-pinned llama architectures', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/ensure-node-llama-mac-deps.js'), 'utf8');
  assert.match(script, /ensureMacOptionalDeps\(/);
  assert.match(script, /lockKey: 'node_modules\/node-llama-cpp'/);
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const optional = lock.packages['node_modules/node-llama-cpp'].optionalDependencies;
  for (const arch of ['mac-arm64-metal', 'mac-x64']) {
    assert.equal(optional[`@node-llama-cpp/${arch}`], lock.packages['node_modules/node-llama-cpp'].version);
    assert.ok(script.includes(`'@node-llama-cpp/${arch}'`));
  }
  for (const command of ['app:build', 'app:build:signed']) {
    assert.ok(pkg.scripts[command].includes('node scripts/ensure-node-llama-mac-deps.js'),
      `${command} must install both macOS binaries before packaging`);
  }
});
