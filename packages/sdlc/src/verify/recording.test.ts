import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordVerificationRun, fingerprintJavaScript, type VerificationRecord } from './recording.js';

const result = { status: 'needs_human' as const, summary: '证据不足', findings: [] };

test('每次运行状态隔离，完整 needs_human 与无裁决不同', async () => {
  const records: VerificationRecord[] = [];
  const emit = async (r: VerificationRecord) => { records.push(r); };
  const [a, b] = await Promise.all([
    recordVerificationRun(emit, {}, {}, async (run) => { run.complete = true; return result; }),
    recordVerificationRun(emit, {}, {}, async () => result),
  ]);
  assert.notEqual(a.verification_run_id, b.verification_run_id);
  assert.equal(a.verification_complete, true);
  assert.equal(b.verification_complete, false);
  for (const output of [a, b]) {
    const own = records.filter((r) => r.run_id === output.verification_run_id);
    assert.deepEqual(own.map((r) => r.seq), [0, 1]);
    assert.deepEqual(own.map((r) => r.kind), ['started', 'finished']);
  }
});

test('异常原样抛出，但取消仍写 finished，结束记录不带已取消信号', async () => {
  const controller = new AbortController();
  const error = new Error('原始异常');
  const records: VerificationRecord[] = [];
  await assert.rejects(recordVerificationRun(async (record, exec) => {
    records.push(record);
    if (record.kind === 'finished') assert.equal(exec.signal, undefined);
  }, { signal: controller.signal }, {}, async () => {
    controller.abort();
    throw error;
  }), (e) => e === error);
  assert.equal(records.at(-1)?.data.outcome, 'cancelled');
  assert.match(String(records.at(-1)?.data.error), /原始异常/);
});

test('等待记录器，归并全部拒绝，收尾拒绝也进入返回诊断', async () => {
  const order: string[] = [];
  const output = await recordVerificationRun(async (r) => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push(r.kind);
    throw new AggregateError([new Error('disk full'), new Error('permission denied')]);
  }, {}, {}, async (run) => {
    assert.deepEqual(order, ['started']);
    run.complete = true;
    return result;
  });
  assert.equal(output.status, 'needs_human');
  assert.equal(output.verification_complete, true);
  assert.equal(output.recording_errors?.length, 4);
  assert.match(output.recording_errors?.join('\n') ?? '', /finished.*permission denied/);
});

test('记录器无法改写真正的返回裁决', async () => {
  const output = await recordVerificationRun(async (r) => {
    const saved = r.data.result as typeof result | undefined;
    if (saved) saved.summary = '被记录器改写';
  }, {}, {}, async (run) => { run.complete = true; return result; });
  assert.equal(output.summary, '证据不足');
});

test('指纹由排序后的运行 JS 决定，排除单测与类型', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sdlc-fingerprint-'));
  try {
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'index.js'), 'export const a=1;');
    writeFileSync(path.join(dir, 'nested', 'helper.js'), 'export const b=2;');
    const before = fingerprintJavaScript(dir);
    writeFileSync(path.join(dir, 'sample.test.js'), 'test only');
    writeFileSync(path.join(dir, 'index.d.ts'), 'types only');
    assert.equal(fingerprintJavaScript(dir), before);
    writeFileSync(path.join(dir, 'nested', 'helper.js'), 'export const b=3;');
    assert.notEqual(fingerprintJavaScript(dir), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
