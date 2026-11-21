# AI 原生 SDLC × DeepSeek Harness

**让 AI 的「完成了」，有据可查。**

DeepSeek Harness（DSH）插件，用于独立检查任务定义与代码、跟踪问题修复和复验，并把进度与证据留在项目里。

[![CI](https://github.com/HMYDK/ai-native-sdlc-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/HMYDK/ai-native-sdlc-dsh/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ai-native-sdlc-plugin/dsh-sdlc)](https://www.npmjs.com/package/@ai-native-sdlc-plugin/dsh-sdlc)
[![dshfind](https://dshfind.com/api/badge/HMYDK/ai-native-sdlc-dsh)](https://dshfind.com/en/plugins/HMYDK/ai-native-sdlc-dsh?ref=badge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 你能得到什么

以下 SPEC 审查和任务级交付证据功能可在 `dev` 分支体验。[从源码构建](docs/installation.md#从源码构建)

- **开工前核对需求。** 在 SPEC 阶段登记原始需求，独立审查遗漏、范围偏移和薄弱的验收标准。当前版本审查的发现逐项收口后，再进入规划与实现。
- **完成有依据。** 新的验证会话读取需求、检查代码、复跑测试，逐项给出验收结果。漏验、无法判断，或代码改了却沿用旧结论，都不能作为通过依据。
- **修复有复验。** 每个问题都有编号、修改说明和测试证据。提交修改后，由独立验证确认是否解决。
- **交付能追溯。** 按任务 ID 查询 SPEC 审查、修订和最终验证。显式登记的 Oracle 有可核对的独立执行记录时，RSI 展示真实执行结果，缺证时标记未验证。
- **换会话能接着做。** 需求、计划、任务状态和验证记录保存在项目文件中，可随代码提交到 Git。后续会话可以读取这些记录继续工作，任务结束后也能据此复盘。

适合有明确验收要求、需要多轮修复或跨会话继续的开发任务。

在 DSH 侧栏打开 SDLC 看板。概览显示 SPEC 审查状态，验证记录显示所选轮次的独立裁决与 Oracle 证据。另有问题处理与阶段历史标签页。[循环工作台](packages/sdlc/README.md#循环工作台)

## 开始使用

需要 **DeepSeek Harness App** 和已配置的可用模型。安装流程已在 macOS 验证，其他平台尚未完整验收。

在 App 的 **Plugin Manager** 中搜索并安装已发布的 `@ai-native-sdlc-plugin/dsh-sdlc`。也可使用 `dsh` 命令安装 `0.6.2`。

```sh
dsh plugin --profile desktop add @ai-native-sdlc-plugin/dsh-sdlc@0.6.2
```

已发布的 `0.6.2` 对应较早的提交。要体验本页的 `dev` 功能，从 `dev` 构建并安装 tarball。[安装指南](docs/installation.md)

1. 安装后重新打开 DSH，进入要开发的项目目录。
2. **新建会话，选择「AI 原生 SDLC」模式。** 工作流按会话启用，已有会话保留原来的工具组合；侧栏只读看板常驻。
3. 在 `dev` 构建的会话中描述原始需求和验收要求。

```text
创建任务 CART-1：修复会员订单优惠计算错误。
登记原始需求和验收标准，先做独立 SPEC 审查，逐项收口后再制定计划并修复。
修复后逐项独立验证；发现问题时记录原因、修改证据和复验结果。
```

Agent 通过插件工具推进任务，你在看板查看进度、问题与证据。任务记录位于 `.ai/tasks/<TASK-ID>/`。

在 SDLC 会话调用 `sdlc_rsi_analyze({task_id: "CART-1"})` 可查看完整审查链、交付证据和缺口。[RSI 用法](packages/sdlc/RSI.md#spec-审查与交付证据)

原始执行记录位于 `.ai/rsi/`，含代码和工具输出；请在业务项目的 `.gitignore` 中忽略该目录，只提交检查过的任务材料。

## 进一步了解

| 想了解什么 | 文档 |
|---|---|
| 安装、升级和排查 | [安装指南](docs/installation.md) |
| 验收标准、阶段流转、问题处理与复验 | [任务流程](packages/sdlc/TASK.md) |
| 用执行证据复盘、比较改进前后的效果 | [复盘与改进](packages/sdlc/RSI.md) |
| 组件划分、测试冻结与实现细节 | [插件说明](packages/sdlc/README.md) · [工程约定](AGENTS.md) |
| 构建、测试与参与开发 | [贡献指南](CONTRIBUTING.md) |

独立验证仍由模型执行，判断可能出错。插件负责记录和检查开发过程，合并与发布授权由 Git、CI 和权限系统负责。

## 来源与许可

方法参考 Anthropic《AI 原生 SDLC 实战手册》（[原文](https://claude.com/resources/articles/the-ai-native-sdlc-playbook) · [中文导读](docs/playbook-notes.md)）。本项目为社区实现，与 Anthropic、DeepSeek 均无隶属关系。

[MIT](LICENSE) · [第三方声明](packages/sdlc/THIRD_PARTY_NOTICES.md) · [安全问题](SECURITY.md)

## English

A **DeepSeek Harness plugin** for independent verification, issue-by-issue fixes, and project-local evidence. The `dev` branch adds a required independent SPEC review before implementation and task-level analysis linking findings, revisions, and observed Oracle execution. Build from source to try these features, select **「AI 原生 SDLC」** in a new session, and follow progress in the dashboard. [Installation](docs/installation.md)
