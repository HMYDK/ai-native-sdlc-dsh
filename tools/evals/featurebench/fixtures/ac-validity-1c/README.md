# AC-VALIDITY-1C offline fixtures

Six minimal, deterministic fixtures used by #22 Phase 1. They are a fixture
builder/checker, **not** an evaluation Runner; no model, Docker, network, or
FeatureBench call is made.

```bash
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py \
  --workdir /tmp/validity-1c-fixtures
```

The script creates six git repos (fixed author/date; base and head commits) under
the workdir, then runs their real entry points with the standard library
`unittest`. It exits 0 only when every observable behavior matches.

| Fixture | Expected behavior | Phase 1 |
|---|---|---|
| `S1_positive` | CSV export works; missing amount exits 2 and names `ord-3` | yes |
| `S2_gap` | author tests pass, real CLI still fails with `NoneType`/`isoformat` | yes |
| `S3_out_of_scope` | target tests pass; external full-CLI test fails on independent `Settings.verbose` bug, no `parse_date` | yes |
| `S4_missing_evidence` | static tests pass; real entry fails on `missing_native_dep` | reserved |
| `S5_unrelated` | target tests pass; `tests_legacy.test_old` fails on base and head | reserved |
| `S6_ambiguity` | interface tests pass; real builder fails on `app.versioning`/`add_uids` | reserved |

The fixture source is embedded in `check_fixtures.py` (`S1_BASE`…`S6_HEAD`) so a
change to the fixture is reviewable and cannot be replaced by a hand-written
`/tmp` directory. See
[`docs/evals/ac-validity-1c-offline-fixtures.md`](../../../../docs/evals/ac-validity-1c-offline-fixtures.md)
for the Phase 1 `sdlc_verify` parameters and DSH Web harness.

This checker is wired into CI `evals-check` and runs without model cost.
