// electron/services/__tests__/ModePinnedResolution.test.mjs
//
// Audit finding #6 — ModesManager.resolveMode(pinnedModeId) is the pin that lets
// the live answer path read the SAME mode the answer was planned from (the
// WhatToAnswerRequestSnapshot's modeUniqueId), even if `modes:set-active` flips
// the active mode while the request is parked at an await. This proves:
//   - a pinned id wins over the (possibly switched) live active mode,
//   - a deleted pinned id falls back to the active mode,
//   - no pin → live active mode (every existing caller, behavior unchanged),
//   - the prompt-suffix / pinned-instructions builders forward the pinned id,
//   - hybrid lexical fallback retains the request's captured mode across awaits.
//
// resolveMode references only this.getModes()/this.getActiveMode(), so we test it
// on a hand-built `this` via prototype-apply (the class ctor needs Electron's DB).
// Run under the Electron ABI so the import graph resolves like production:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test <file>

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/services/ModesManager.js');
const { ModesManager } = await import(pathToFileURL(modPath).href);
const { ModeContextRetriever } = await import(pathToFileURL(path.join(path.dirname(modPath), 'ModeContextRetriever.js')).href);
const { buildWhatToAnswerRequestSnapshot } = await import(pathToFileURL(path.resolve(path.dirname(modPath), '../llm/whatToAnswerRequestSnapshot.js')).href);

const TI = { id: 'mode_ti', templateType: 'technical-interview', name: 'TI', customContext: '', isActive: true, createdAt: '' };
const SALES = { id: 'mode_sales', templateType: 'general', name: 'Sales', customContext: 'Pitch hard.', isActive: false, createdAt: '' };

function ctxWith(activeMode, modes) {
  return {
    getActiveMode: () => activeMode,
    getModes: () => modes,
  };
}

describe('ModesManager.resolveMode (audit finding #6)', () => {
  test('no pinned id → returns the live active mode (unchanged behavior)', () => {
    const ctx = ctxWith(TI, [TI, SALES]);
    const mode = ModesManager.prototype.resolveMode.call(ctx, undefined);
    assert.equal(mode.id, 'mode_ti');
  });

  test('pinned id wins over the live active mode (the mid-request-switch guard)', () => {
    // Live active mode is SALES (a switch happened mid-request), but the request
    // was planned with TI pinned → resolveMode must return TI.
    const ctx = ctxWith(SALES, [TI, SALES]);
    const mode = ModesManager.prototype.resolveMode.call(ctx, 'mode_ti');
    assert.equal(mode.id, 'mode_ti', 'pinned mode must win over the switched-to active mode');
  });

  test('pinned id that no longer exists (deleted mid-request) falls back to active', () => {
    const ctx = ctxWith(SALES, [SALES]);
    const mode = ModesManager.prototype.resolveMode.call(ctx, 'mode_ti_deleted');
    assert.equal(mode.id, 'mode_sales', 'deleted pinned mode → fall back to active');
  });

  test('no active mode and no pin → null', () => {
    const ctx = ctxWith(null, []);
    const mode = ModesManager.prototype.resolveMode.call(ctx, undefined);
    assert.equal(mode, null);
  });
});

describe('the prompt builders forward the pinned id to resolveMode (source guard)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../ModesManager.ts'), 'utf8');

  test('suffix / pinned-instructions / retrieval (sync + hybrid) all take + use pinnedModeId', () => {
    assert.match(src, /getActiveModeSystemPromptSuffix\(pinnedModeId\?: string\)/);
    assert.match(src, /getActiveModePinnedInstructions\(answerType\?: AnswerType, pinnedModeId\?: string\)/);
    // pinnedModeId is present; trailing params (retrievalOptions?:
    // ModeRetrievalOptions — round-6) may follow it, so don't require it to be
    // the LAST param.
    assert.match(src, /buildRetrievedActiveModeContextBlock\([^)]*pinnedModeId\?: string(,\s*\w+\?:[^)]*)?\)/);
    // Hybrid takes pinnedModeId; trailing `allowRerank?: boolean` (Phase 1
    // smart-retrieval) and/or other params may follow it.
    assert.match(src, /buildRetrievedActiveModeContextBlockHybrid\([^)]*pinnedModeId\?: string(,\s*[^)]*)?\)/);
    // Each must resolve via the pin, not a bare getActiveMode().
    const suffix = src.slice(src.indexOf('getActiveModeSystemPromptSuffix(pinnedModeId'));
    assert.match(suffix.slice(0, 200), /this\.resolveMode\(pinnedModeId\)/);
  });
});

describe('hybrid lexical fallback keeps the request mode across awaits', () => {
  for (const pinned of [true, false]) {
    for (const forceDocumentGrounding of [false, true]) {
      for (const outcome of ['empty', 'throw']) {
        test(`${pinned ? 'snapshot pin' : 'captured active mode'} / ${forceDocumentGrounding ? 'document-grounded' : 'standard'} / ${outcome}`, { timeout: 5000 }, async t => {
          let activeMode = TI;
          const files = [TI, SALES].map(mode => ({
            id: `ref_${mode.id}`, modeId: mode.id, fileName: `${mode.id}.md`, createdAt: '',
            content: `Quasar handoff protocol: ${mode.id === TI.id ? 'TI_ONLY_EVIDENCE' : 'SALES_ONLY_EVIDENCE'}. Validate the quasar handoff before release.`,
          }));
          const ctx = Object.assign(Object.create(ModesManager.prototype), {
            getActiveMode: () => activeMode,
            getModes: () => [TI, SALES],
            getActiveModeInfo: () => ({ id: activeMode.id, templateType: activeMode.templateType, name: activeMode.name }),
            getReferenceFiles: id => files.filter(file => file.modeId === id),
            modeContextRetriever: new ModeContextRetriever(),
          });
          const snapshot = buildWhatToAnswerRequestSnapshot({
            modeReader: ctx, requestId: 'pinned-fallback-test', generationId: 1,
          });
          assert.ok(Object.isFrozen(snapshot));
          assert.equal(snapshot.modeUniqueId, TI.id);
          assert.equal(snapshot.modeId, TI.templateType);

          let release;
          let entered;
          const pending = new Promise(resolve => { release = resolve; });
          const started = new Promise(resolve => { entered = resolve; });
          t.after(() => release());
          const hybrid = t.mock.method(ctx.modeContextRetriever, 'retrieveHybrid', async () => {
            entered();
            await pending;
            if (outcome === 'throw') throw new Error('fixture hybrid outage');
            return { formattedContext: '', chunks: [], usedFallback: true, usedHybrid: false };
          });
          const lexical = t.mock.method(ctx.modeContextRetriever, 'retrieve');
          const fallback = t.mock.method(ctx, 'buildRetrievedActiveModeContextBlock');
          const retrievalOptions = { forceDocumentGrounding, followUpReferentHint: 'Quasar handoff' };
          const result = ctx.buildRetrievedActiveModeContextBlockHybrid(
            'quasar handoff protocol', 'Discuss the quasar handoff.', 1024,
            'coding_question_answer', true, pinned ? snapshot.modeUniqueId : undefined, false, retrievalOptions,
          );
          await started;
          assert.equal(hybrid.mock.callCount(), 1);
          assert.equal(hybrid.mock.calls[0].arguments[0].id, TI.id);
          assert.deepEqual(hybrid.mock.calls[0].arguments[1].map(file => file.modeId), [TI.id]);
          assert.equal(fallback.mock.callCount(), 0, 'fallback must not run before the await completes');
          assert.equal(ctx.getActiveMode().id, TI.id);
          activeMode = SALES;
          release();

          const context = await result;
          assert.equal(ctx.getActiveMode().id, SALES.id, 'the live mode really switched');
          assert.equal(snapshot.modeUniqueId, TI.id, 'the request snapshot did not switch');
          assert.equal(fallback.mock.callCount(), 1);
          assert.deepEqual(fallback.mock.calls[0].arguments, [
            'quasar handoff protocol', 'Discuss the quasar handoff.', 1024,
            'coding_question_answer', true, TI.id, retrievalOptions,
          ], 'fallback preserves the captured mode and every retrieval argument');
          assert.equal(lexical.mock.callCount(), 1);
          assert.equal(lexical.mock.calls[0].arguments[0].id, TI.id);
          assert.deepEqual(lexical.mock.calls[0].arguments[1].map(file => file.modeId), [TI.id]);
          assert.match(context, /TI_ONLY_EVIDENCE/, 'real lexical retrieval keeps request-mode evidence');
          assert.doesNotMatch(context, /SALES_ONLY_EVIDENCE|Pitch hard\./, 'switched-mode evidence must not bleed');
        });
      }
    }
  }
});
