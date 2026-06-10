# 引擎 Spike：薄 loop 自研 vs Claude Agent SDK（决策型计划）

> 这是一个 **timeboxed 探索 spike**，不是 TDD 实施计划。产出是一份决策文档 + 可丢弃的验证代码，不是生产软件。对应 PRD v3 §14 Q4（与 Q3 模型选型绑定）。

**Timebox：2 天。到点必须出裁决，禁止延期"再试试"。**

**要回答的唯一问题：** v1 引擎的"步骤内短时 agent loop"（PRD §5 双层架构的内层）用什么实现——(A) 自研 ~500 行架在现有 `src/runtime/`（ToolRunner/EventBus/Hooks）上，还是 (B) Claude Agent SDK？

## 前置事实（已定，不在 spike 范围内重开）

- 外层编排 = local-store 状态机 + 调度，与本 spike 无关（PRD §5 已裁决）。
- 国内消费者层走国产模型 + 薄云中转（PRD §9 已裁决）→ loop 必须能对接 OpenAI 兼容接口。
- 不 fork 任何源码（PRD §5 已裁决）。

## Spike 内容（每项产出写进 DECISION.md）

**Day 1 — 路线 B（Agent SDK）验证：**
1. 用 Claude Agent SDK 跑通最小英雄流程切片：给定选题 + 风格规则注入 → 调用一个自定义工具（读 `creator-profile.json`）→ 产出口播脚本草稿。
2. 关键测试：**把 model provider 换成国产模型的 OpenAI 兼容 endpoint**（豆包/通义/DeepSeek 任选其一经中转代理）——SDK 是否支持自定义 baseURL / 第三方模型？tool-use 协议在国产模型上是否正常工作？
3. 记录：依赖体积、冷启动时间、上下文管理是否可控（能否禁用我们不要的压缩/子代理）、错误处理可观测性。

**Day 2 — 路线 A（自研薄 loop）验证：**
1. 在 `spikes/thin-loop/`（不进 src/）写最小 loop：messages 数组 + OpenAI 兼容 `/chat/completions` 带 tools 调用 + while 循环执行 tool_calls 直到无工具调用或达预算上限（轮次/token）。复用 `src/runtime/ToolRunner` 执行工具。
2. 同一英雄流程切片跑通，与 Day 1 同输入对比输出质量与 token 消耗。
3. 记录：实际行数、需要自己处理的边角（流式、重试、tool 参数校验——`src/utils/retry.ts` 已有重试）。

## 决策标准（按权重排序，DECISION.md 逐项打分）

| 标准 | 权重 | 路线 A 风险 | 路线 B 风险 |
|---|---|---|---|
| 国产模型 OpenAI 兼容接口能跑通 tool-use | 一票否决 | 低（协议自己控） | 待验证（SDK 对非 Anthropic 模型的支持） |
| 步骤内预算上限（轮次/token）可强制 | 高 | 自己实现，~20 行 | 需确认 SDK 暴露此控制 |
| 维护成本（升级追赶 / 行为黑盒） | 高 | 全白盒，无升级依赖 | 跟随 Anthropic 维护，但行为演进不受控 |
| 接入薄云中转计费的改造量 | 中 | 天然（baseURL 即中转） | 待验证 |
| 开发速度（到能跑的英雄流程） | 中 | 慢几天 | 快 |

**预判（写在前面防锚定漂移）：** 若 SDK 对国产模型 + baseURL 中转支持顺畅 → 选 B；任何一项一票否决标准失败 → 选 A，不纠结。

## 产出

- `docs/superpowers/plans/DECISION-engine.md`：裁决 + 打分表 + 证据（代码片段/报错原文）。
- `spikes/` 目录代码标注"可丢弃，不许 import 进 src/"。
- 裁决写回 PRD §14 Q4（划掉，标已裁决）。
- 裁决后解锁计划 4（薄 loop 引擎 + 进程内生成）的编写。
