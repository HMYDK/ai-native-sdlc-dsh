import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { dispatchVerifier, type VerifierRequest } from './runtime.js';
import type { VerificationRecording } from './recording.js';

const stopped: SubagentResult = { output: [], stopReason: 'aborted' };
const done: SubagentResult = { output: [], stopReason: 'completed' };
const request = {} as VerifierRequest;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const recorder = (record: VerificationRecording['record'] = async () => {}): VerificationRecording =>
  ({ id: 'controlled-run', complete: false, cancelled: false, record });

test('post-publication abort disposes the activation while its result is still pending', async () => {
  const controller = new AbortController();
  const published = deferred<void>();
  const result = deferred<SubagentResult>();
  let disposes = 0;
  // Match rc.3: the startup signal does NOT cancel a published activation.
  const ctx = { subagents: { startActivation: async () => ({ childId: 'child', result: result.promise,
    dispose: async () => { disposes++; result.resolve(stopped); } }) } } as unknown as Context;
  const pending = dispatchVerifier(ctx, 'spawn', request, controller.signal,
    recorder(async kind => { if (kind === 'attempt_session') published.resolve(); }), 1);
  await published.promise;
  controller.abort();
  await setImmediate();
  try { assert.equal(disposes, 1, 'waiting for result before dispose would leave the child running'); }
  finally { result.resolve(stopped); await pending; }
  assert.equal(disposes, 1, 'cancellation and finally join a single disposal');
});

test('an abort racing with startup completion disposes the returned handle', async () => {
  const controller = new AbortController();
  const result = deferred<SubagentResult>();
  let disposes = 0;
  const ctx = { subagents: { startActivation: async () => {
    controller.abort();
    return { childId: 'child', result: result.promise,
      dispose: async () => { disposes++; result.resolve(stopped); } };
  } } } as unknown as Context;
  const pending = dispatchVerifier(ctx, 'spawn', request, controller.signal, recorder(), 1);
  await setImmediate();
  try { assert.equal(disposes, 1); }
  finally { result.resolve(stopped); await pending; }
  assert.equal(disposes, 1);
});

test('normal completion disposes once and detaches the later abort listener', async () => {
  const controller = new AbortController();
  let disposes = 0;
  const ctx = { subagents: { startActivation: async () => ({ childId: 'child', result: Promise.resolve(done),
    dispose: async () => { disposes++; } }) } } as unknown as Context;
  assert.equal((await dispatchVerifier(ctx, 'spawn', request, controller.signal, recorder(), 1)).result.stopReason, 'completed');
  controller.abort();
  await setImmediate();
  assert.equal(disposes, 1);
});
