# Plan: 客户自助查询理赔状态

From: spec.md（v1）

## Files that change

**新增**
- `claims-api/routes/status.py` —— `GET /claims/{id}/status`
- `claims-api/tests/test_status.py` —— 接口测试
- `portal/src/claims/StatusPanel.tsx` —— 门户面板
- `portal/src/claims/stateMapping.ts` —— 内部 10 态 → 客户 4 态映射
- `portal/src/claims/useClaimStatus.ts` —— 带 60 秒缓存的取数 hook
- `portal/src/claims/StatusPanel.test.tsx` —— 面板测试（含四种状态的渲染）

**修改**
- `portal/src/nav/PortalNav.tsx` —— 挂上"我的理赔"入口
- `portal/src/i18n/zh.json`、`en.json` —— 状态与下一步措辞

**不动**（明确划出边界）
- 理赔核心处理逻辑
- 认证通道
- 邮件通知

## Order of work

1. **先定状态映射表**（`stateMapping.ts` + 单测）。它是 R4 的核心，
   而且门户与接口的接口面由它决定——先做它，避免接口写成内部状态的透传。
2. 新增 `GET /claims/{id}/status`，**在现有认证之后**，只返回该客户的理赔。
   先只返回 `state` 与 `nextStep`，`etaRange` 留到第 4 步。
3. 门户面板接上接口（**先不缓存**），把四种状态的渲染跑通。
4. 补 `etaRange`：区间计算放在 API 侧（它才知道处理时长分布）。
5. 加缓存（`useClaimStatus`），并把缓存命中率与总调用量记进日志。
6. 挂导航入口 + i18n 收尾。
7. **在预发环境实测 claims-core 总调用量**（见 Risks 第 3 条的对应处置）。

## Risks

1. **限流叠加（对应 spec 关注点 3）**。50 rps 是总配额，客服系统也在用。
   缓存放大了安全边际，但**没有实测过**叠加后的峰值。
   处置：第 7 步在预发实测；若峰值逼近限额，面板缓存时间从 60 秒上调。

2. **`nextStep` 可能泄露理赔类型（对应 spec 关注点 2）**。
   处置：`nextStep` 只用通用措辞；具体材料清单留在登录后的详情页。
   这一点**不是工程能单独决定的**，需要在评审中由合规确认。

3. **区间措辞被当作承诺（对应 spec 关注点 1）**。
   处置：把 `etaRange` 的文案交给法务确认后再上线；必要时加免责说明。

4. **授权边界写错会泄露他人理赔**。这是本计划里**唯一的高危项**。
   处置：接口测试必须包含"用 A 的会话查 B 的理赔 → 404/403"这条用例，
   而且它必须在测试里**显式存在**，不能靠"框架默认会拦"。

5. **状态映射与客服系统口径漂移**。内部状态新增时映射表不会自动跟上。
   处置：映射表的单测里断言"已知内部状态集合 == spec.md Design 表枚举的 10 个"，
   使新增内部状态时测试失败而不是静默落到默认分支。

## Proof

| 验收标准 | 用什么证明 |
|---|---|
| R1：接口只返回该客户自己的理赔 | `test_status.py::test_cross_customer_access_denied`（用 A 的会话查 B 的理赔，断言 403/404） |
| R2：门户展示状态/下一步/预计日期 | `StatusPanel.test.tsx` 覆盖四种客户状态的渲染；快照与已确认的设计稿比对 |
| R3：面板读取不超过 claims-core 限流 | 预发环境实测总调用量日志（第 7 步），附峰值截图；单测只覆盖缓存命中逻辑（`useClaimStatus.test.ts`） |
| R4：对外只暴露 4 态 | `stateMapping.test.ts` 断言 spec.md Design 表枚举的 10 个内部状态全部有映射，且输出集合恰为 4 个 |
| R5：会话与前端缓存无理赔详情 | 浏览器存储快照比对（sessionStorage/localStorage 为空）；网络面板确认响应体只有 state/nextStep/etaRange |
| 全量回归 | `make test` 与 `make lint` 原始输出 |

**已知无法用测试证明的**：R3 的限流余量（依赖预发实测）、
以及"文案不构成承诺"（属法务判断）。
