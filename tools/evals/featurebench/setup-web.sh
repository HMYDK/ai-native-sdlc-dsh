#!/bin/bash
# FeatureBench 评测容器内：准备隔离 DSH home、手动安装 SDLC 插件、启动 web 服务。
#
# 约定：
# - Node 24 与 dsh CLI 已由 bake_base.py 烤进派生镜像，本脚本不再安装它们；
# - 只读取 /opt/inject 下的最小注入内容（凭据、插件、启动脚本），
#   容器内没有任何宿主目录挂载（事故记录见 README「安全与隔离」）；
# - web 必须绑定容器 IP（不是 127.0.0.1），否则宿主端口映射连不进来。
set -e
INJ=/opt/inject
export DSH_HOME=/opt/dsh-eval
export PATH=/opt/node24/bin:$PATH
PROVIDER="${DSH_EVAL_PROVIDER:-deepseek-account}"
MODEL="${DSH_EVAL_MODEL:-deepseek-flash}"
EFFORT="${DSH_EVAL_REASONING_EFFORT:-max}"
WEB_PORT="${WEB_PORT:-3115}"

mkdir -p "$DSH_HOME"
cp "$INJ/credentials.yaml" "$DSH_HOME/.credentials.yaml"
chmod 600 "$DSH_HOME/.credentials.yaml"

dsh --version
dsh --profile web --dump-default-config >/dev/null
P="$DSH_HOME/profiles/web"
mkdir -p "$P/node_modules/@ai-native-sdlc-plugin"
rm -rf "$P/node_modules/@ai-native-sdlc-plugin/dsh-sdlc"
cp -r "$INJ/plugin/dsh-sdlc" "$P/node_modules/@ai-native-sdlc-plugin/dsh-sdlc"
cp -r "$INJ/plugin/js-yaml" "$P/node_modules/js-yaml"
node -e '
const fs=require("fs");const p=process.argv[1];
const d=JSON.parse(fs.readFileSync(p,"utf8"));
d.dependencies=d.dependencies||{};
d.dependencies["@ai-native-sdlc-plugin/dsh-sdlc"]="0.6.0";
d.dsh=d.dsh||{};d.dsh.profile=d.dsh.profile||{};d.dsh.profile.bundles=d.dsh.profile.bundles||[];
if(!d.dsh.profile.bundles.includes("@ai-native-sdlc-plugin/dsh-sdlc")) d.dsh.profile.bundles.push("@ai-native-sdlc-plugin/dsh-sdlc");
fs.writeFileSync(p,JSON.stringify(d,null,2));
' "$P/package.json"

# 模型路由 + 权限默认（官方镜像无可用 sandbox 后端）+ 评测卫生（不外传日志）。
cat > "$P/cordis.patch.yml" <<YAML
- id: agent-default-model
  config:
    provider: "$PROVIDER"
    model: "$MODEL"
    reasoningEffort: "$EFFORT"
- id: permission
  config:
    defaultPreset: danger-full-access
- id: workspace-controller
  config:
    documentsDirectory: /eval-root
- id: session-log-deepseek
  disabled: true
- id: otel
  disabled: true
- id: session-telemetry-otel
  disabled: true
YAML

# 默认工作区指向 /testbed（FeatureBench 的任务仓库），避免 agent 改到别处。
mkdir -p /eval-root/deepseek-harness
rm -rf /eval-root/deepseek-harness/default-workspace
ln -sfn /testbed /eval-root/deepseek-harness/default-workspace

IP=$(hostname -i | awk '{print $1}')
cd /testbed
# 容器继承了宿主 docker CLI 注入的代理变量（127.0.0.1 在容器内不可达），必须清掉。
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
nohup dsh web --no-open --port "$WEB_PORT" --host "$IP" > "$DSH_HOME/web.log" 2>&1 &
sleep 12
grep -o "token=[A-Za-z0-9_-]*" "$DSH_HOME/web.log" | head -1 > "$DSH_HOME/token.txt" || true
tail -2 "$DSH_HOME/web.log"
