#!/usr/bin/env node
/**
 * Sequential, cross-platform Electron test runner — no shell involved.
 *
 * Why this exists:
 *
 *   The known-good way to execute these suites (see the `test` script in
 *   package.json) is one Electron test-runner process per FILE. Whole-directory
 *   invocations of `electron --test` are rejected by Electron, and globbing a
 *   directory into ONE process couples every file's fate: a crash in one test
 *   module takes down the whole batch with no way to tell which file broke.
 *
 *   The npm-script form also bakes in POSIX assumptions (globs resolved by
 *   sh, or passed literally through cmd.exe on Windows), which is exactly the
 *   platform drift this repo's CI keeps catching. This script removes the
 *   shell from the picture entirely: it discovers the files itself and spawns
 *   each runner directly with process.execPath + a fixed argument vector that
 *   behaves identically on macOS and Windows.
 *
 * Discovery: every `*.test.mjs` living under any `__tests__/` directory
 * within electron/, in deterministic (lexicographic, slash-normalized) order
 * so macOS and Windows legs process files in the same sequence.
 *
 * Each file runs exactly this known-good shape, with stdio inherited:
 *
 *   <node> scripts/run-with-env.mjs \
 *     --default-tmpdir NATIVELY_TEST_USERDATA=natively-test-userdata \
 *     --default-tmpdir CODEX_HOME=natively-test-codex-home \
 *     --set ELECTRON_RUN_AS_NODE=1 \
 *     -- electron --test <electron/.../__tests__/file.test.mjs>
 *
 * The run NEVER stops at the first failure: every file gets a verdict line
 * (`[PASS] <path>` or `[FAIL] <path> (exit N)`) plus a final summary, and the
 * process exits 0 only if zero files failed. CI therefore sees one exact file
 * per failure instead of one opaque batch.
 *
 * Usage:
 *
 *   node scripts/run-electron-tests.mjs [path-substring ...]
 *
 * Optional positional args narrow the run to discovered files whose repo-
 * relative path CONTAINS any of them — a plain substring match against the
 * slash-normalized paths (e.g. `electron/courses`). With NO args every
 * discovered file runs; that full local sweep stays available exactly as
 * before. CI invokes this scoped on purpose, see build-smoke.yml.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(repoRoot, 'electron');

// Directories that never contain real source tests; skipping them keeps the
// walk fast and immune to stray vendored trees.
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Recursively collect `*.test.mjs` files under any `__tests__/` directory. */
function discoverTestFiles(dir, relativeTo) {
  const found = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // Unreadable directory: report nothing from it, keep going.
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...discoverTestFiles(absolute, relativeTo));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.test.mjs') &&
      path.relative(relativeTo, dir).split(path.sep).includes('__tests__')
    ) {
      // Store slash-normalized paths so ordering and display are identical on
      // both operating systems regardless of native separator.
      found.push(path.relative(relativeTo, absolute).split(path.sep).join('/'));
    }
  }

  return found;
}

/** Run one test file through the known-good run-with-env command shape. */
function runTestFile(relPath) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/run-with-env.mjs',
      '--default-tmpdir',
      'NATIVELY_TEST_USERDATA=natively-test-userdata',
      '--default-tmpdir',
      'CODEX_HOME=natively-test-codex-home',
      '--set',
      'ELECTRON_RUN_AS_NODE=1',
      '--',
      'electron',
      '--test',
      relPath,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return result;
}

function main() {
  // Optional positional args are repo-relative substring filters (see header);
  // with none given the predicate is true for every file, so no-args behavior
  // is byte-for-byte the original full discovery.
  const filters = process.argv.slice(2);
  const files = discoverTestFiles(electronDir, repoRoot)
    .filter((file) => filters.length === 0 || filters.some((part) => file.includes(part)))
    .sort();

  if (files.length === 0) {
    console.error(`run-electron-tests: no test files${filters.length ? ` matching [${filters.join(', ')}]` : ''} under electron/**/__tests__ — nothing to pass, refusing.`);
    return 1;
  }

  console.log(`Running ${files.length} Electron test files sequentially`);

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const result = runTestFile(file);
    // spawnSync: status null means the launcher itself died (or was signaled);
    // anything nonzero from run-with-env is a genuine test failure.
    if (!result.error && result.status === 0) {
      passed += 1;
      console.log(`[PASS] ${file}`);
    } else {
      failed += 1;
      if (result.error) console.error(`run-electron-tests: failed to launch ${file}: ${result.error.message}`);
      console.log(`[FAIL] ${file} (exit ${result.status ?? 1})`);
    }
  }

  console.log(`total ${files.length} passed ${passed} failed ${failed}`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
