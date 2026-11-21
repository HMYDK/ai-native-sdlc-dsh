import test from 'node:test';
import assert from 'node:assert/strict';
import {cancelAfterResponse, cancelBeforeStep} from './budget.mjs';

test('the observed 94,798-token response can submit its terminal result under an 80,000-token threshold', () => {
  const content = [{type: 'reasoning', text: 'not exported'}, {type: 'tool-call', name: 'structured_output', arguments: '{}'}];
  assert.equal(cancelAfterResponse(94798, 80000, content), false);
  // If validation rejects the submission, the next model step is still stopped.
  assert.equal(cancelBeforeStep(94798, 80000, 5, 12), true);
});

test('a terminal submission cannot conceal more tools or free-form continuation over budget', () => {
  assert.equal(cancelAfterResponse(94798, 80000, [{type: 'text', text: 'done'}]), true);
  assert.equal(cancelAfterResponse(94798, 80000, [{type: 'tool-call', name: 'read'}]), true);
  assert.equal(cancelAfterResponse(94798, 80000, [{type: 'tool-call', name: 'structured_output'}, {type: 'tool-call', name: 'bash'}]), true);
});

test('work within the observed budget can continue but a step limit still stops another request', () => {
  assert.equal(cancelAfterResponse(70000, 80000, [{type: 'tool-call', name: 'read'}]), false);
  assert.equal(cancelBeforeStep(70000, 80000, 12, 12), false);
  assert.equal(cancelBeforeStep(70000, 80000, 13, 12), true);
});
