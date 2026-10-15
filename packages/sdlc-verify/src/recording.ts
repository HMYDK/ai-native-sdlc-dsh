/** Awaited, per-invocation verification records. Observers never decide the verdict. */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Verdict } from './verdict.js';

export interface VerificationRecord {
  schema_version: 1;
  run_id: string;
  seq: number;
  at: string;
  kind: 'started' | 'prepared' | 'attempt_started' | 'attempt_session' | 'attempt_finished' | 'finished';
  data: Record<string, unknown>;
}
export interface VerificationExec { agent?: unknown; signal?: AbortSignal; callId?: string }
export type VerificationEmitter = (record: VerificationRecord, exec: VerificationExec) => Promise<void> | void;

declare module '@deepseek-ai/cordis' {
  interface Events {
    'sdlc-verify/record'(record: VerificationRecord, exec: VerificationExec): Promise<void> | void;
  }
}

/** Include filenames and lengths so different file boundaries cannot share a digest. */
export function fingerprintJavaScript(directory: string): string {
  const files: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && name.endsWith('.js') && !name.endsWith('.test.js')) files.push(name);
    }
  };
  visit('');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const bytes = readFileSync(path.join(directory, file));
    hash.update(`${file.replaceAll(path.sep, '/')}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

// Computed once when this runtime module loads, never from a later rebuild on disk.
export const VERIFIER_FINGERPRINT = fingerprintJavaScript(path.dirname(fileURLToPath(import.meta.url)));

export function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return Array.from(error.errors).flatMap(errorMessages);
  return [error instanceof Error ? `${error.name}: ${error.message}` : String(error)];
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

export interface VerificationRecording {
  complete: boolean;
  cancelled: boolean;
  record(kind: VerificationRecord['kind'], data: Record<string, unknown>): Promise<void>;
}

/** All exits, including pre-dispatch errors, pass through this finalizer. */
export async function recordVerificationRun(
  emit: VerificationEmitter,
  exec: VerificationExec,
  started: Record<string, unknown>,
  operation: (run: VerificationRecording) => Promise<Verdict>,
): Promise<Verdict> {
  const runId = randomUUID();
  let seq = 0;
  const errors: string[] = [];
  let output: Verdict | undefined;
  let failure: unknown;
  let failed = false;
  const run: VerificationRecording = {
    complete: false,
    cancelled: false,
    async record(kind, data) {
      const recordSeq = seq++;
      try {
        // A recorder receives its own data, so it cannot rewrite the live verdict.
        const record: VerificationRecord = {
          schema_version: 1, run_id: runId, seq: recordSeq,
          at: new Date().toISOString(), kind, data: structuredClone(data),
        };
        // Cancellation must not cancel the evidence of cancellation itself.
        const recordExec = exec.signal?.aborted ? { agent: exec.agent, callId: exec.callId } : exec;
        await emit(record, recordExec);
      } catch (error) {
        errors.push(...errorMessages(error).map((message) => `${kind}[${recordSeq}]: ${message}`));
      }
    },
  };
  await run.record('started', started);
  try {
    output = {
      ...await operation(run),
      verification_run_id: runId,
      verification_complete: run.complete,
    };
    return output;
  } catch (error) {
    failure = error;
    failed = true;
    throw error;
  } finally {
    if (output && errors.length) output.recording_errors = [...errors];
    await run.record('finished', {
      outcome: run.cancelled || isCancellation(failure, exec.signal) ? 'cancelled'
        : failed ? 'error' : run.complete ? 'completed' : 'no_verdict',
      ...(output ? { result: output } : {}),
      ...(failed ? { error: errorMessages(failure).join('; ') } : {}),
      ...(errors.length ? { recording_errors: [...errors] } : {}),
    });
    if (output && errors.length) output.recording_errors = [...errors];
  }
}
