#!/usr/bin/env bash
# End-to-end reproducible verification of the probe conclusion:
#   a third-party bundle patch with two rows that name THIS package's own
#   subpath exports (@probe/two-rows/a, @probe/two-rows/b) is auto-installed,
#   auto-appended to dsh.profile.bundles, and BOTH rows activate in a real
#   `dsh` boot of the isolated profile. A profile-layer `disabled: true` on one
#   row proves row-level switches are independent (and reversible).
#
# Writes only under <repo>/.probe/repro-* ; never touches ~/.dsh or the desktop profile.
# Usage: .probe/repro.sh
set -u
REPO="<WORKSPACE>/AI Native SDLC"
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
TGZ="$REPO/.probe/dist/probe-two-rows-0.0.0.tgz"
HOME_DIR="$REPO/.probe/repro-home"
ART="$REPO/.probe/repro"
PASS=0
FAIL=0
check() { # name, exit-code-of-condition
  if [ "$2" -eq 0 ]; then echo "PASS  $1"; PASS=$((PASS + 1)); else echo "FAIL  $1"; FAIL=$((FAIL + 1)); fi
}
jcheck() { # description, js-boolean-result-file
  if [ "$(cat "$2")" = "true" ]; then echo "PASS  $1"; PASS=$((PASS + 1)); else echo "FAIL  $1 ($(cat "$2"))"; FAIL=$((FAIL + 1)); fi
}
dsh() { ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" "$@"; }

rm -rf "$HOME_DIR" "$ART"
mkdir -p "$ART/logs" "$ART/markers"
export DSH_HOME="$HOME_DIR"

echo "=== environment ==="
echo "app: $APP"
echo "cli: $CLI"
dsh --version > "$ART/logs/version.txt" 2>&1
echo "cli version: $(cat "$ART/logs/version.txt")"
ELECTRON_RUN_AS_NODE=1 "$APP" -p 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})' > "$ART/logs/runtime-versions.json" 2>&1
echo "runtime: $(cat "$ART/logs/runtime-versions.json")"
echo "tgz sha256: $(shasum -a 256 "$TGZ" | awk '{print $1}')"
echo "pnpm on PATH: $(command -v pnpm || echo '<absent — CLI uses its bundled pnpm>')"

echo
echo "=== S1: plugin add auto-initializes a missing profile and reconciles bundles ==="
dsh plugin --profile probe add "$TGZ" > "$ART/logs/s1-add.log" 2>&1
check "S1 add exit 0" $?
grep -q "initialized profile probe" "$ART/logs/s1-add.log"; check "S1 add log says profile was initialized" $?
ELECTRON_RUN_AS_NODE=1 "$APP" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(p.dsh.profile.bundles.includes("@probe/two-rows"))' "$HOME_DIR/profiles/probe/package.json" > "$ART/logs/s1-bundle-in-manifest.txt" 2>&1
jcheck "S1 dsh.profile.bundles auto-contains @probe/two-rows" "$ART/logs/s1-bundle-in-manifest.txt"
cp "$HOME_DIR/profiles/probe/package.json" "$ART/logs/s1-profile-package.json"
dsh --profile probe --dump-config > "$ART/logs/s1-dump.yml" 2> "$ART/logs/s1-dump.err"
check "S1 dump-config exit 0" $?
grep -q -- "- id: probe-a" "$ART/logs/s1-dump.yml"; check "S1 dump has row probe-a" $?
grep -q -- "- id: probe-b" "$ART/logs/s1-dump.yml"; check "S1 dump has row probe-b" $?
grep -q "name: '@probe/two-rows/a'" "$ART/logs/s1-dump.yml"; check "S1 row probe-a names the package subpath export ./a" $?
grep -q "name: '@probe/two-rows/b'" "$ART/logs/s1-dump.yml"; check "S1 row probe-b names the package subpath export ./b" $?

echo
echo "=== S2: --from-default-profile web replaces the profile wholesale (order matters) ==="
dsh --profile probe --from-default-profile web --dump-config > "$ART/logs/s2-web-template-dump.yml" 2> "$ART/logs/s2-web-template.err"
check "S2 recreate-from-web-template dump exit 0" $?
cp "$HOME_DIR/profiles/probe/package.json" "$ART/logs/s2-profile-package.json"
ELECTRON_RUN_AS_NODE=1 "$APP" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(p.dsh.profile.bundles.includes("@deepseek-ai/dsh-web-app"))' "$HOME_DIR/profiles/probe/package.json" > "$ART/logs/s2-webapp-in-manifest.txt" 2>&1
jcheck "S2 recreated profile bundles include dsh-web-app" "$ART/logs/s2-webapp-in-manifest.txt"
ELECTRON_RUN_AS_NODE=1 "$APP" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(!p.dsh.profile.bundles.includes("@probe/two-rows"))' "$HOME_DIR/profiles/probe/package.json" > "$ART/logs/s2-probe-gone.txt" 2>&1
jcheck "S2 recreated profile no longer lists @probe/two-rows (install was replaced)" "$ART/logs/s2-probe-gone.txt"
if grep -q "probe-a" "$ART/logs/s2-web-template-dump.yml"; then FAIL=$((FAIL + 1)); echo "FAIL  S2 recreated dump has no probe row"; else PASS=$((PASS + 1)); echo "PASS  S2 recreated dump has no probe row"; fi

echo
echo "=== S3: add the same tgz into the web-template profile ==="
dsh plugin --profile probe add "$TGZ" > "$ART/logs/s3-add.log" 2>&1
check "S3 add exit 0" $?
cp "$HOME_DIR/profiles/probe/package.json" "$ART/logs/s3-profile-package.json"
dsh --profile probe --dump-config > "$ART/logs/s3-dump.yml" 2>&1
check "S3 dump-config exit 0" $?
grep -q "name: '@probe/two-rows/a'" "$ART/logs/s3-dump.yml"
check "S3 composed tree still contains both fixture rows" $?

boot_expect() { # name | expected marker basenames separated by comma (or "none")
  local name="$1" expect="$2"
  local mdir="$ART/markers/$name" log="$ART/logs/$name.log"
  rm -rf "$mdir"; mkdir -p "$mdir"
  PROBE_MARKER_DIR="$mdir" ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" \
    --profile probe --port 0 --no-open > "$log" 2>&1 &
  local pid=$!
  local deadline=$((SECONDS + 90)) ok=1
  if [ "$expect" != "none" ]; then
    while [ "$SECONDS" -lt "$deadline" ]; do
      ok=1
      for marker in ${expect//,/ }; do [ -f "$mdir/$marker" ] || ok=0; done
      [ "$ok" -eq 1 ] && break
      kill -0 "$pid" 2>/dev/null || { ok=0; break; }
      sleep 0.5
    done
  else
    sleep 5
  fi
  sleep 2
  kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  echo "$pid" > "$ART/logs/$name.pid"
  echo "boot[$name] pid=$pid expected=$expect"
}
marker_present() { [ -f "$ART/markers/$1/$2" ]; }
marker_absent() { [ ! -f "$ART/markers/$1/$2" ]; }

echo
echo "=== S4: real boot, both rows expected to activate ==="
boot_expect s4-both a.txt,b.txt
marker_present s4-both a.txt; check "S4 real boot wrote a.txt (row probe-a activated)" $?
marker_present s4-both b.txt; check "S4 real boot wrote b.txt (row probe-b activated)" $?
grep -q "dsh web: http" "$ART/logs/s4-both.log"; check "S4 boot log shows the web app actually started (dsh web: http...)" $?
grep -q "entry did not activate" "$ART/logs/s4-both.log" && FAIL=$((FAIL + 1)) || PASS=$((PASS + 1))
if grep -q "entry did not activate" "$ART/logs/s4-both.log"; then echo "FAIL  S4 no 'entry did not activate'"; else echo "PASS  S4 no 'entry did not activate'"; fi

echo
echo "=== S5: profile layer disables only probe-b ==="
cat > "$HOME_DIR/profiles/probe/cordis.patch.yml" <<'YAML'
# Probe experiment: disable exactly one of the two rows contributed by the fixture bundle.
- id: probe-b
  disabled: true
YAML
dsh --profile probe --dump-config > "$ART/logs/s5-dump-disabled.yml" 2>&1
check "S5 dump-config exit 0" $?
grep -q "disabled: true" "$ART/logs/s5-dump-disabled.yml"; check "S5 dump marks probe-b disabled" $?
boot_expect s5-disabled-a-only a.txt
marker_present s5-disabled-a-only a.txt; check "S5 boot still wrote a.txt (probe-a stays enabled)" $?
marker_absent s5-disabled-a-only b.txt; check "S5 boot did NOT write b.txt (probe-b disabled at row level)" $?
if grep -q "entry did not activate" "$ART/logs/s5-disabled-a-only.log"; then echo "FAIL  S5 disabled row produces no 'entry did not activate'"; FAIL=$((FAIL + 1)); else echo "PASS  S5 disabled row produces no 'entry did not activate'"; PASS=$((PASS + 1)); fi

echo
echo "=== S6: restore the profile layer, both rows activate again (reversible) ==="
cat > "$HOME_DIR/profiles/probe/cordis.patch.yml" <<'YAML'
# Probe profile patch layer, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
[]
YAML
dsh --profile probe --dump-config > "$ART/logs/s6-dump-reenabled.yml" 2>&1
check "S6 dump-config exit 0" $?
boot_expect s6-reenabled a.txt,b.txt
marker_present s6-reenabled a.txt; check "S6 boot wrote a.txt after re-enable" $?
marker_present s6-reenabled b.txt; check "S6 boot wrote b.txt after re-enable" $?

echo
echo "=== marker contents (pid must equal that boot's pid) ==="
for m in "$ART"/markers/*/*.txt; do echo "--- $m"; cat "$m"; done
for d in "$ART"/markers/*/; do
  name=$(basename "$d")
  pid=$(cat "$ART/logs/$name.pid" 2>/dev/null || echo missing)
  for f in "$d"*.txt; do
    [ -f "$f" ] || continue
    if grep -q "pid: $pid" "$f"; then echo "PASS  marker $(basename "$d")/$(basename "$f") was written by boot pid $pid"; PASS=$((PASS + 1)); else echo "FAIL  marker $(basename "$d")/$(basename "$f") pid mismatch (boot $pid)"; FAIL=$((FAIL + 1)); fi
  done
done

echo
echo "=== boot logs ==="
for f in "$ART"/logs/s4-both.log "$ART"/logs/s5-disabled-a-only.log "$ART"/logs/s6-reenabled.log; do echo "--- $f"; cat "$f"; done

echo
echo "=== RESULT: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
