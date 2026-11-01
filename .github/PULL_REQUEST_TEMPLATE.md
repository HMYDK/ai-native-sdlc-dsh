## 为什么改

<!-- 原行为哪里不对、有什么风险、在什么条件下触发。不要只写“更新了 X”。 -->

## 改了什么

<!-- 范围、关键取舍、考虑过但放弃的方案。 -->

## 怎么验证

<!-- 贴命令和实际读数；没跑的项写“未跑”和原因，不要省略。 -->

- [ ] `npm run build --workspace packages/sdlc`
- [ ] `npm run typecheck`
- [ ] `npm test --workspace packages/sdlc`
- [ ] `DSH_APP="/Applications/DeepSeek Harness.app" npm run verify --workspace packages/sdlc`（含冒烟，需要真实 App）
- [ ] `npm run compat` / `npm run preset-sync`（改动 peer 范围或 preset 副本时）
- [ ] 涉及加载、安装或界面接线：已把真实 tarball 装进隔离 profile 核对，并附读数

## 影响与遗留

<!-- 行为变化、兼容性、未覆盖的部分、后续任务。 -->

## 提交前检查

- [ ] 已按 `git ls-files` 逐个审查跟踪文件，没有用 `git add -A` 盲推
- [ ] 没有提交凭据、`.ai/rsi/` 原始记录、`.ai/tasks/SMOKE-*/`、`*.tgz`、`output/` 截图或 `.idea/`
- [ ] 文档（README、`docs/`、`packages/sdlc/*.md`）与代码一致
- [ ] 提交信息说明了“为什么”
