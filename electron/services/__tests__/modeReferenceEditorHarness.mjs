// Executes the actual reference-file section and its upload callback. Hooks and
// IPC are isolated; transpilation is in memory and never rewrites the scaffold.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const modesEditorPath = path.join(root, 'premium/src/ModesSettings.tsx');

function children(node) {
  if (!node || typeof node !== 'object') return [];
  const value = node.props?.children;
  return Array.isArray(value) ? value.flat(Infinity) : [value];
}

function findUpload(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' && children(node).some((child) => typeof child === 'string' && child.startsWith('Upload'))) return node;
  for (const child of children(node)) {
    const button = findUpload(child);
    if (button) return button;
  }
  return null;
}

export function referenceEditorHarness({
  platform, file, blobAvailable = true, uploadResult, initialFiles = [], unsafeSize = false,
}) {
  const source = fs.readFileSync(modesEditorPath, 'utf8');
  const ast = ts.createSourceFile(modesEditorPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['formatBytes', 'approxSizeFromContent', 'safeGet', 'renderStatusBadge', 'ReferenceFilesSection'];
  const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  const body = declarations.map((node) => unsafeSize && node.name.text === 'approxSizeFromContent'
    ? 'function approxSizeFromContent(content: string): number { return content.length; }'
    : node.getText(ast)).join('\n');
  const slots = [];
  let cursor = 0;
  const calls = { uploads: [], reads: 0 };
  const api = {
    modesUploadReferenceFile: async (modeId) => {
      calls.uploads.push(modeId);
      return uploadResult ?? { success: true, file };
    },
    modesGetReferenceFiles: async (modeId) => {
      assert.equal(modeId, 'selected-mode');
      calls.reads++;
      return [file];
    },
    modesGetReferenceFileStatus: async () => ({ success: true, statuses: [] }),
  };
  const code = ts.transpileModule(`(() => {
    const api = () => window.electronAPI;
    ${body}
    return ReferenceFilesSection;
  })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const Section = vm.runInNewContext(code, {
    require, exports: {}, console, window: { electronAPI: api }, process: { platform },
    Blob: blobAvailable ? globalThis.Blob : undefined,
    ...Object.fromEntries(['FileText', 'MoreHorizontal', 'Trash2', 'Loader2', 'Paperclip']
      .map((name) => [name, require('lucide-react')[name]])),
    useCallback: (callback) => callback,
    useEffect: () => {},
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = index === 0 ? initialFiles : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
  });
  const render = () => {
    cursor = 0;
    return Section({ modeId: 'selected-mode' });
  };
  return {
    calls,
    upload: async () => {
      const button = findUpload(render());
      assert.ok(button, 'the actual section must expose its upload callback');
      await button.props.onClick();
    },
    markup: () => renderToStaticMarkup(render()),
  };
}
