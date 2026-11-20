import assert from 'node:assert/strict';

export function controlledSpecActivation(request, childId) {
  if (request.label !== 'sdlc-spec-review') return undefined;
  return {childId, dispose: async () => {}, result: Promise.resolve({
    output: [], stopReason: 'completed',
    structured: {summary: 'Controlled prerequisite for a downstream test.', findings: [], follow_up: [], limitations: []},
  })};
}

export async function reviewFixture(call, taskId) {
  const result = await call('sdlc_spec_review', {task_id: taskId});
  assert.ok(!result.isError && result.value.review_complete, JSON.stringify(result));
  return result.value;
}
