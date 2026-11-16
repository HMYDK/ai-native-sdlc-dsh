#!/bin/bash
# Targeted Phase 1 execution isolation for one frozen call.
# Default is --prepare-only: start a fresh per-call DSH_HOME/Web/Chrome, let the
# driver insert the frozen prompt, then STOP at the pre-Enter gate. The live DSH
# workspace is checked through /api/sdlc-ui.tasks before any prompt is sent.
# --execute additionally requires PHASE1_EXECUTION_AUTHORIZED=YES; it is not for
# zero-model validation.
set -u
CALL="${1:?usage: run_isolated.sh CALL --prepare-only|--execute WEB_PORT CDP_PORT}"
MODE="${2:?mode required}"
WEB_PORT="${3:?web port required}"
CDP_PORT="${4:?cdp port required}"
ROOT="${PHASE1_ROOT:-/tmp/phase1}"
REPO="$(cd "$(dirname "$0")/../../../../../.." && pwd)"
PLAN="$REPO/tools/evals/featurebench/fixtures/ac-validity-1c/phase1/plan.yml"
CHECK="$REPO/tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_workspace_session.py"
DRIVER="$REPO/tools/evals/featurebench/driver.mjs"
DSH_CLI="${DSH_CLI:?set DSH_CLI to the DSH 0.2.2-rc.3 executable}"
FIXTURES="${PHASE1_FIXTURES:-/tmp/validity-1c-fixtures}"
OUT="$ROOT/out/$CALL-isolated"
GATE="$OUT/gate"
CHROME_DIR="$ROOT/isolated/$CALL/chrome"
HOME_DIR="$ROOT/isolated/$CALL/home"
EVAL_ROOT="$ROOT/isolated/$CALL/eval-root"
mkdir -p "$OUT" "$HOME_DIR" "$EVAL_ROOT/deepseek-harness" "$CHROME_DIR" "$GATE"

read -r SCEN ARM WS < <(python3 - "$PLAN" "$CALL" <<'PY'
import sys,yaml
p=sys.argv[1]; cid=sys.argv[2]
d=yaml.safe_load(open(p))
c=next(c for c in d["calls"] if c["id"]==cid)
print(c["scenario"],c["arm"],c["workspace"])
PY
)
PLUGIN="$ROOT/plugins/$ARM"
[ -d "$PLUGIN/dsh-sdlc" ] || { echo "ERROR missing plugin $PLUGIN" >&2; exit 30; }

cleanup() {
  [ -n "${DRIVER_PID:-}" ] && kill "$DRIVER_PID" 2>/dev/null || true
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

export DSH_HOME="$HOME_DIR"
"$DSH_CLI" --profile web --dump-default-config >/dev/null
PROFILE="$DSH_HOME/profiles/web"
mkdir -p "$PROFILE/node_modules/@ai-native-sdlc-plugin"
cp -R "$PLUGIN/dsh-sdlc" "$PROFILE/node_modules/@ai-native-sdlc-plugin/dsh-sdlc"
cp -R "$PLUGIN/js-yaml" "$PROFILE/node_modules/js-yaml"
node -e '
 const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));
 d.dependencies=d.dependencies||{};d.dependencies["@ai-native-sdlc-plugin/dsh-sdlc"]="0.6.2";
 d.dsh=d.dsh||{};d.dsh.profile=d.dsh.profile||{};d.dsh.profile.bundles=d.dsh.profile.bundles||[];
 if(!d.dsh.profile.bundles.includes("@ai-native-sdlc-plugin/dsh-sdlc"))d.dsh.profile.bundles.push("@ai-native-sdlc-plugin/dsh-sdlc");
 fs.writeFileSync(p,JSON.stringify(d,null,2));' "$PROFILE/package.json"
cat > "$PROFILE/cordis.patch.yml" <<YAML
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
- id: permission
  config:
    defaultPreset: danger-full-access
- id: workspace-controller
  config:
    documentsDirectory: $EVAL_ROOT
- id: session-log-deepseek
  disabled: true
- id: otel
  disabled: true
- id: session-telemetry-otel
  disabled: true
YAML
cp "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
chmod 600 "$DSH_HOME/.credentials.yaml"
ln -sfn "$FIXTURES/$(basename "$WS")" "$EVAL_ROOT/deepseek-harness/default-workspace"

for p in "$WEB_PORT" "$CDP_PORT"; do lsof -ti tcp:$p 2>/dev/null | xargs -r kill 2>/dev/null || true; done
cd "$WS" || exit 31
nohup "$DSH_CLI" web --no-open --port "$WEB_PORT" --host 127.0.0.1 > "$OUT/web.log" 2>&1 &
WEB_PID=$!
TOKEN=""
for i in $(seq 1 60); do
  TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$OUT/web.log" 2>/dev/null | head -1 | cut -d= -f2)
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "ERROR no web token; see $OUT/web.log" >&2; exit 32; }
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new \
  --remote-debugging-port="$CDP_PORT" --user-data-dir="$CHROME_DIR" --no-first-run \
  "http://127.0.0.1:$WEB_PORT/?token=$TOKEN" > "$OUT/chrome.log" 2>&1 &
CHROME_PID=$!
for i in $(seq 1 30); do
  curl -sS --max-time 1 "http://127.0.0.1:$CDP_PORT/json/list" > "$OUT/targets.json" 2>/dev/null || true
  grep -q "127.0.0.1:$WEB_PORT" "$OUT/targets.json" 2>/dev/null && break
  sleep 1
done
grep -q "127.0.0.1:$WEB_PORT" "$OUT/targets.json" 2>/dev/null || { echo "ERROR no Chrome target" >&2; exit 33; }

PHASE1_GATE_DIR="$GATE" WEB_PORT="$WEB_PORT" MAX_TOKENS=2000000 MAX_WALL_S=1200 \
  node "$DRIVER" "$CDP_PORT" "AI 原生 SDLC" "$ROOT/prompts/$SCEN.txt" "$OUT/driver-result.json" \
  > "$OUT/driver.log" 2>&1 &
DRIVER_PID=$!
for i in $(seq 1 120); do
  [ -f "$GATE/ready.json" ] && break
  sleep 1
done
[ -f "$GATE/ready.json" ] || { echo "ERROR driver did not reach pre-prompt gate" >&2; exit 34; }

CHECK_ARGS=()
if [ -n "${PHASE1_EXPECTED_OVERRIDE:-}" ]; then
  CHECK_ARGS=(--expected "$PHASE1_EXPECTED_OVERRIDE")
fi
python3 "$CHECK" --port "$WEB_PORT" --token "$TOKEN" --call "$CALL" "${CHECK_ARGS[@]}" > "$OUT/workspace-check.log" 2>&1
CHECK_RC=$?
cat "$OUT/workspace-check.log"
if [ "$CHECK_RC" -ne 0 ]; then
  echo "FAIL_CLOSED: workspace check failed; no prompt sent" >&2
  exit 35
fi
if [ "$MODE" = "--prepare-only" ]; then
  echo "PREPARE_ONLY_OK: workspace verified; prompt not sent; call=$CALL"
  exit 0
fi
if [ "$MODE" != "--execute" ]; then
  echo "ERROR unknown mode $MODE" >&2
  exit 36
fi
if [ "${PHASE1_EXECUTION_AUTHORIZED:-}" != "YES" ]; then
  echo "ERROR --execute requires PHASE1_EXECUTION_AUTHORIZED=YES" >&2
  exit 37
fi
touch "$GATE/proceed"
wait "$DRIVER_PID"
DRIVER_RC=$?
[ -d "$WS/.ai/rsi" ] && { mv "$WS/.ai/rsi" "$OUT/ai-rsi-rsi"; rmdir "$WS/.ai" 2>/dev/null || true; }
# Post-call: compare the run's recorded Git head/diff against plan.
python3 - "$OUT" "$CALL" <<'PY'
import json,pathlib,sys
out=pathlib.Path(sys.argv[1]); cid=sys.argv[2]
runs=sorted((out/"ai-rsi-rsi").glob("runs/*/code.json"))
if not runs:
    print("POSTCHECK_FAIL: no RSI code.json", file=sys.stderr); raise SystemExit(1)
d=json.loads(runs[-1].read_text())
print("POSTCHECK_HEAD",d.get("head"),"DIFF_LEN",len(d.get("diff","")))
PY
exit "$DRIVER_RC"
