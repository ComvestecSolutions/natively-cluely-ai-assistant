// electron/services/__tests__/ModeReferenceFileIngestResultContent2026_07_26.test.mjs
//
// Bug fix (2026-07-26, live-testing session): `ingestModeReferenceFile`'s
// returned `ModeReferenceFileIngestResult` omitted `content` even though
// `extractSafeDocumentText`'s result (`extracted.content`) was fully
// available at the call site. `modes:upload-reference-file` (ipcHandlers.ts)
// returns this result verbatim as `{ success: true, file }`, and
// `ModesSettings.tsx`'s `uploadFile()` pushes it straight into its
// `referenceFiles` list, then unconditionally renders `file.content.length`
// for every row — so every successful reference-file upload crashed the
// Modes settings panel (`Cannot read properties of undefined (reading
// 'length')`, caught by the renderer's ErrorBoundary) until the next full
// reload, which re-fetches via `modes:get-reference-files` (whose
// `rowToFile` mapping in ModesManager.ts always included `content`).
//
// Live-reproduced during a real upload of a 66-page PDF into a custom
// document-grounded mode (Session 2026-07-26 shadow-observation testing).
//
// The backend return contract is source-pinned. The renderer regression runs
// the current upload callback and reference-file section, substituting only
// hooks/IPC. It also runs an unsafe in-memory mutation to prove the assertions
// catch missing content guards, rather than pinning the old editor's spelling.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modesEditorPath, referenceEditorHarness } from './modeReferenceEditorHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ingestionSrc = fs.readFileSync(
  path.resolve(__dirname, '../ModeReferenceFileIngestion.ts'),
  'utf8',
);
const modesSettingsSrc = fs.readFileSync(modesEditorPath, 'utf8');
after(() => assert.equal(fs.readFileSync(modesEditorPath, 'utf8'), modesSettingsSrc,
  'callback/render tests must never replace the local premium scaffold'));

describe('ModeReferenceFileIngestResult includes content (the actual bug)', () => {
  test('the interface declares a required `content: string` field', () => {
    const ifaceStart = ingestionSrc.indexOf('export interface ModeReferenceFileIngestResult {');
    const ifaceEnd = ingestionSrc.indexOf('\n}', ifaceStart);
    const iface = ingestionSrc.slice(ifaceStart, ifaceEnd);
    assert.match(iface, /\n\s*content: string;/, 'content must be declared, and required (no `?`)');
  });

  test('the returned object literal actually includes `content: extracted.content`', () => {
    const returnStart = ingestionSrc.lastIndexOf('return {');
    const returnEnd = ingestionSrc.indexOf('};', returnStart);
    const returnBody = ingestionSrc.slice(returnStart, returnEnd);
    assert.match(returnBody, /content:\s*extracted\.content/, 'the actual returned value must carry the real extracted content, not be omitted');
  });
});

describe('ModesSettings.tsx render site is defensive even if a future backend regression omits content again', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const blobAvailable of [true, false]) {
      for (const [label, content] of [['missing', undefined], ['null', null], ['empty', ''], ['Unicode', 'résumé']]) {
        test(`${platform}: upload/render handles ${label} content ${blobAvailable ? 'with Blob' : 'through the fallback'}`, async () => {
          const file = { id: 'uploaded', fileName: 'Uploaded reference.txt', ...(content === undefined ? {} : { content }) };
          const h = referenceEditorHarness({ platform, file, blobAvailable });
          await h.upload();
          assert.deepEqual(h.calls.uploads, ['selected-mode']);
          assert.equal(h.calls.reads, 1, 'the callback must rehydrate authoritative files');
          const markup = h.markup();
          assert.match(markup, /Uploaded reference\.txt/);
          const expected = content ? (blobAvailable ? '8 B' : '6 B') : '0 KB';
          assert.ok(markup.includes(expected), 'missing content needs a numeric zero fallback; valid Unicode text needs a real size');
        });
      }
    }

    for (const cancelled of [true, false]) {
      test(`${platform}: ${cancelled ? 'cancelled' : 'refused'} upload keeps existing file rows`, async () => {
        const existing = { id: 'existing', fileName: 'Existing reference.txt', content: 'Retained' };
        const h = referenceEditorHarness({
          platform, initialFiles: [existing], file: { id: 'unused', fileName: 'Must not appear.txt' },
          uploadResult: cancelled ? { cancelled: true } : { success: false, error: 'write_refused' },
        });
        await h.upload();
        assert.equal(h.calls.reads, 0);
        const markup = h.markup();
        assert.match(markup, /Existing reference\.txt/);
        assert.doesNotMatch(markup, /Must not appear/);
        if (!cancelled) assert.match(markup, /write_refused/);
      });
    }
  }

  test('the actual render rejects an unsafe in-memory content.length mutation', async () => {
    const h = referenceEditorHarness({
      platform: 'win32', file: { id: 'uploaded', fileName: 'Missing content.txt' }, unsafeSize: true,
    });
    await h.upload();
    assert.throws(() => h.markup(), /length/, 'removing the content safeguard must make the regression signal go red');
  });
});
