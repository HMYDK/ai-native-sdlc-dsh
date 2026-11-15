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
- `check_phase1_plan.py` — offline validator: order/uniqueness, A/B identity,
  same-scenario input identity, input/prompt/diff hashes, gold labels, paths and
  per-call monitor settings. `--self-test` mutates order/label/hash/input and
  asserts rejection; it never starts DSH, Chrome or a model.

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
  --fixtures-root /tmp/ac-validity-1c-fixtures
```
