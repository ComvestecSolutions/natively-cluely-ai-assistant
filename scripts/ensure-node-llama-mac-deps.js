#!/usr/bin/env node
/** Ensure both macOS llama.cpp binaries exist before packing x64 and arm64 apps. */
const path = require('node:path');
const { ensureMacOptionalDeps } = require('./lib/ensure-mac-optional-deps.cjs');

ensureMacOptionalDeps({
  label: 'ensure-node-llama-mac-deps',
  rootDir: path.resolve(__dirname, '..'),
  lockKey: 'node_modules/node-llama-cpp',
  required: ['@node-llama-cpp/mac-arm64-metal', '@node-llama-cpp/mac-x64'],
  tmpPrefix: 'node-llama-darwin-dep-',
});
