// electron/services/__tests__/WtaActiveCodingProblem2026_09_23.test.mjs
//
// Issue #539: What to Answer lost the active coding problem. The hot window is
// 180s; the interviewer stated a key-rotation problem, the conversation moved on,
// and "show the solution in python" then routed general_meeting_answer with no
// problem attached — live, the model answered an unrelated count_ways(n).
//
// Real SessionTracker (real coding-question detection from transcript segments)
// + real IntelligenceEngine.runWhatShouldISay. Only the provider call is stubbed:
// it captures the exact prompt that would leave the process.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
if (!process.env.NATIVELY_TEST_USERDATA) {
  process.env.NATIVELY_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wta-active-coding-'));
}
const { SessionTracker } = require(path.resolve(repoRoot, 'dist-electron/electron/SessionTracker.js'));
const { IntelligenceEngine } = require(path.resolve(repoRoot, 'dist-electron/electron/IntelligenceEngine.js'));

function makeHelper(captured) {
  const base = {
    setNegotiationCoachingHandler() {}, isUsingOllama() { return false; }, canUseLocalFallback() { return false; },
    getPromptTier() { return 'cloud'; }, getCapabilities() { return { contextWindow: 128000, supportsVision: true }; },
    fitContextForCurrentModel(x) { return x; }, rememberAnswerCall() {},
    async *streamChat(...a) {
      captured.push({ system: String(a[3] ?? ''), user: String(a[0] ?? '') });
      yield 'Here it is:\n```python\ndef rotate():\n    return 1\n```\n';
    },
  };
  return new Proxy(base, { get(t, k) { return k in t ? t[k] : undefined; }, has() { return true; } });
}

const PROBLEM = 'Implement a function to rotate the active encryption key at the top of every hour, and return the key version used.';

async function press(segments) {
  const now = Date.now();
  const session = new SessionTracker();
  for (const [agoSec, speaker, text] of segments) {
    session.handleTranscript({ speaker, text, timestamp: now - agoSec * 1000, final: true });
  }
  const captured = [];
  const engine = new IntelligenceEngine(makeHelper(captured), session);
  await engine.runWhatShouldISay(undefined, 0.9, undefined, { skipCooldown: true });
  assert.equal(captured.length, 1, 'one provider call per press');
  return captured[0];
}

// Problem stated >180s before the press, so it is outside the hot window.
const earlier = [
  [330, 'interviewer', 'So we have two microservices. Service A encrypts messages and service B decrypts them.'],
  [320, 'interviewer', PROBLEM],
  [150, 'user', 'Okay, so I would keep a map from key version to key.'],
  [120, 'interviewer', 'Sounds good, keep going.'],
  [60, 'user', 'And each message carries its version in a header.'],
];

describe('WTA keeps the active coding problem for a coding continuation (#539)', () => {
  for (const ask of ['show the solution in python', 'show in python', 'show me how you would implement in python']) {
    test(`"${ask}" reaches the model with the evicted problem`, async () => {
      const { system, user } = await press([...earlier, [3, 'interviewer', ask]]);
      const prompt = `${system}\n${user}`;
      assert.ok(prompt, 'the provider was called');
      assert.match(prompt, /rotate the active encryption key/, 'problem statement missing from the prompt');
      assert.match(prompt, /follow-up to the coding problem/, 'the ask was not resolved against the problem');
    });
  }

  test('a behavioural question after the coding problem does NOT inherit it', async () => {
    const assertBehavioralRouting = ({ system, user }, v3Enabled) => {
      // V3 carries the question in <current_question>; V3-off with v2 enabled
      // carries it in the last <current_turn>. Older conversation is not the ask.
      const current = v3Enabled
        ? /<current_question[^>]*>\s*# Question\n([^\n]+)\s*<\/current_question>/.exec(user)
        : [...user.matchAll(/<current_turn>\n([^\n]+)\n<\/current_turn>/g)].at(-1);
      assert.ok(current, 'the current question reaches the provider');
      assert.doesNotMatch(current[1], /follow-up to the coding problem/i, 'current question must not be a coding follow-up');
      assert.equal(current[1].trim(), 'Tell me about your experience with python');
      assert.doesNotMatch(current[1], /rotate the active encryption key/i);

      // Inspect only instructions governing THIS ask, not historical transcript
      // or the prior assistant reply. A v2-off system has no <active_action> tag.
      let activeInstructions;
      if (v3Enabled) {
        activeInstructions = `${system}\n${user.slice(0, current.index)}`;
        assert.match(activeInstructions, /# Source authority\n- Personal claims require/);
        assert.match(activeInstructions, /# Grounding\nAnswer normally\./);
      } else {
        const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(user);
        assert.ok(task, 'V3-off active task reaches the provider');
        activeInstructions = `${system}\n${task[1]}`;
        assert.match(task[1], /answerType:\s*skill_experience_answer/);
        assert.match(task[1], /profileContextPolicy:\s*required/);
      }
      assert.doesNotMatch(activeInstructions, /follow-up to the coding problem|# Follow-up\b|answerType:\s*(?:coding|dsa_question_answer)/i);
      assert.doesNotMatch(activeInstructions, /rotate the active encryption key/i);
      return current;
    };

    const previousV3 = process.env.NATIVELY_CONTEXT_INTELLIGENCE_V3;
    const previousV2 = process.env.NATIVELY_PROMPT_SYSTEM_V2;
    try {
      for (const [v3, v2] of [['1', '1'], ['1', '0'], ['0', '1']]) {
        process.env.NATIVELY_CONTEXT_INTELLIGENCE_V3 = v3;
        process.env.NATIVELY_PROMPT_SYSTEM_V2 = v2;
        await press([...earlier, [3, 'interviewer', 'show the solution in python']]);
        const outbound = await press([...earlier, [3, 'interviewer', 'Tell me about your experience with python']]);
        if (v3 === '1') {
          assert.match(outbound.user, /Question heard in the meeting: show the solution in python \(follow-up to the coding problem:/);
        }
        const current = assertBehavioralRouting(outbound, v3 === '1');

        // Changing only the active question must fail, despite retained coding history.
        const mutatedUser = outbound.user.replace(current[0], current[0].replace(
          'Tell me about your experience with python',
          `show in python (follow-up to the coding problem: "${PROBLEM}")`));
        assert.notEqual(mutatedUser, outbound.user, 'the active question was mutated');
        assert.throws(() => assertBehavioralRouting({ ...outbound, user: mutatedUser }, v3 === '1'),
          /current question must not be a coding follow-up/);
      }
    } finally {
      if (previousV3 === undefined) delete process.env.NATIVELY_CONTEXT_INTELLIGENCE_V3;
      else process.env.NATIVELY_CONTEXT_INTELLIGENCE_V3 = previousV3;
      if (previousV2 === undefined) delete process.env.NATIVELY_PROMPT_SYSTEM_V2;
      else process.env.NATIVELY_PROMPT_SYSTEM_V2 = previousV2;
    }
  });

  // The old turns can still reach the prompt through the durable meeting-transcript
  // block (unchanged by this fix); what must not happen is the question being
  // rewritten as a follow-up to the OLD problem.
  test('a new, self-contained coding question is NOT rewritten onto the old problem', async () => {
    const { system, user } = await press([...earlier, [3, 'interviewer', 'Now write a function that reverses a linked list in place.']]);
    const prompt = `${system}\n${user}`;
    assert.ok(prompt, 'the provider was called');
    assert.doesNotMatch(prompt, /follow-up to the coding problem/);
    assert.match(prompt, /reverses a linked list/);
  });
});
