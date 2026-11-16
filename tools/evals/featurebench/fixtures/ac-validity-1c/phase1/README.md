# Phase 1 frozen 6-call plan

This directory is the **zero-model** Phase 1 preparation deliverable requested in
[#22 comment 6898799392](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22#issuecomment-6898799392).
It does not authorize or start any paid call.

- `plan.yml` — 6 calls in fixed order: `S1-A → S1-B → S2-A → S2-B → S3-A → S3-B`.
  Each row has the scenario gold label, A/B commit + tarball SHA256, fixture
  base/head + diff SHA256, the five `sdlc_verify` inputs, prompt SHA256, input
  SHA256, DSH_HOME/ports/workspace, output/log paths and per-call monitoring.
- `gold-labels.md` — the pre-result gold-label record, based on the project
  requirement owner's confirmation in the linked issue comment. It is not a
  model verdict and must not be revised after seeing A/B output.
- `prompts/S*.txt` — the exact prompt passed to the main DSH web session for each
  scenario; the JSON is embedded verbatim. The main session calls
  `sdlc_verify` once (standalone, no `task_id`).
- `run_isolated.sh` — targeted per-call execution isolation (no new general
  Runner): fresh `DSH_HOME`, Web/Chrome session, unique per-invocation gate
  directory and per-call ports; starts the existing driver with
  `PHASE1_GATE_DIR`, which inserts the frozen prompt and **stops before Enter**.
  `check_workspace_session.py` reads the active composer session ID from the
  gate, then the persisted `session.header.identity.cwd` from
  `DSH_HOME/storages/session_projcache`; it requires that actual cwd to be the
  frozen scenario and checks Git base/head/diff. It does **not** use Dashboard
  candidate roots. `--prepare-only` kills the driver before any prompt;
  `--execute` is rejected before any setup unless
  `PHASE1_EXECUTION_AUTHORIZED=YES`; each invocation has a new gate directory so
  stale `ready.json`/`proceed` cannot leak. `PHASE1_EXPECTED_OVERRIDE` and
  `PHASE1_WORKSPACE_OVERRIDE` are negative-test hooks only.
- `check_verifier_snapshot.py` — post-call: finds the actual
  `.ai/rsi/runs/*/code.json` and requires `complete=true`, `issues==[]`,
  `diff==""` (no tracked working-tree changes), no unexpected untracked
  source/test files (only `out.csv`/Python caches allowed), `head` equal to the
  plan call head, and matching workspace Git base/head/diff. Missing/incomplete/
  wrong snapshots exit non-zero; the runner marks the call invalid (exit 40), not
  success.
- `check_driver_result.py` — reads `driver-result.json` **and the real
  `.ai/rsi/runs/*/000005.json` recording**; the main Agent body is not proof.
  A real verdict requires `verification_complete:true`, `raw_status`, and
  `verification_run_id`; a real `needs_human` counts as completed, while the
  plugin's generation-failure fallback `needs_human` (or body-only `status`)
  is `no_verdict`. Exit codes: normal+real verdict=0; complete but no real
  verdict=10; missing/incomplete=11; aborted (timeout/over_budget)=12;
  turn_error=13. A real Verifier verdict found on a turn_error/aborted attempt
  is still preserved in `driver-classification.json` as a separate fact, while
  the exit/status reports the Driver failure (dual-dimension accounting).
  `run_isolated.sh --classify-only RESULT OUTDIR [RSI_ROOT]` exercises the same
  classification/exit/status path without DSH/Chrome/model.
- `check_phase1_plan.py` — offline validator: order/uniqueness, A/B identity,
  same-scenario input identity, input/prompt/diff hashes, gold labels, paths,
  per-call monitor settings, and the **actual `calls[].workspace`**. It rejects
  tracked staged/unstaged changes; it allows only the known generated `out.csv`
  and Python caches as untracked files, rejecting any other untracked file that
  could affect test discovery or the entrypoint. `--self-test` mutates
  order/label/hash/input/workspace and asserts rejection; `--dirty-workspace-test`
  stages/unstages S2 `app/dates.py` in an isolated copy. Neither starts DSH,
  Chrome or a model.

## Execution prerequisites (not execution)

- Set `DSH_CLI` to a DSH `0.2.2-rc.3` CLI path; do not rely on `dsh` being on
  `PATH`. The preflight used the installed App's bundled CLI, but that exact
  `/tmp` path is not a stable contract.
- The 8M-token / 2h totals are **soft approval/monitoring targets**, not a hard
  guarantee. `driver.mjs` enforces the per-call `MAX_TOKENS=2000000` and
  `MAX_WALL_S=1200` monitors; if usage is unavailable or a stop fails, the
  executor must stop the remaining calls manually and report. Failures/timeouts
  stay in the 6-call ITT denominator; no selective retry.
- Run only after explicit Phase 1 approval. Phase 2/B1 are out of scope.

Validation (offline):

```bash
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_phase1_plan.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_phase1_plan.py \
  --fixtures-root /tmp/validity-1c-fixtures
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_phase1_plan.py \
  --dirty-workspace-test --fixtures-root /tmp/validity-1c-fixtures
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_phase1_plan.py \
  --stage-prompts /tmp/phase1/prompts
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_verifier_snapshot.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_driver_result.py --self-test
# zero-model isolation check (per-call home; no prompt sent)
DSH_CLI=/path/to/dsh bash tools/evals/featurebench/fixtures/ac-validity-1c/phase1/run_isolated.sh \
  S2-A --prepare-only 61001 9301
# negative hooks (all must be fail-closed / no prompt):
PHASE1_EXPECTED_OVERRIDE=/tmp/validity-1c-fixtures/S3_out_of_scope \
  DSH_CLI=/path/to/dsh bash tools/evals/featurebench/fixtures/ac-validity-1c/phase1/run_isolated.sh \
  S2-A --prepare-only 61002 9302          # exit 35, no prompt
PHASE1_WORKSPACE_OVERRIDE=/tmp/validity-1c-fixtures/S3_out_of_scope \
  DSH_CLI=/path/to/dsh bash tools/evals/featurebench/fixtures/ac-validity-1c/phase1/run_isolated.sh \
  S2-A --prepare-only 61003 9303          # exit 35, no prompt
DSH_CLI=/path/to/dsh bash tools/evals/featurebench/fixtures/ac-validity-1c/phase1/run_isolated.sh \
  S2-A --execute 61004 9304               # exit 37 before setup
```
