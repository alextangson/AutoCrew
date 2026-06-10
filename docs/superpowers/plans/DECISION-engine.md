# 引擎裁决：自研薄 loop（2026-06-10 spike 实测）

> 对应 [2026-06-10-engine-spike.md](2026-06-10-engine-spike.md)，裁决 PRD §14 Q4。
> 证据：`spikes/spike-engine/DAY1-NOTES.md`（SDK 路线）、`spikes/thin-loop/DAY2-NOTES.md`（自研路线）。

## 裁决

**v1 引擎的"步骤内短时 agent loop"采用自研薄 loop**（架在现有 src/runtime 之上），不用 Claude Agent SDK，不 fork 任何源码。

## 打分表（计划预注册的标准）

| 标准 | 权重 | A 自研薄 loop | B Agent SDK |
|---|---|---|---|
| 国产模型 OpenAI 兼容 tool-use | **一票否决** | ✅ 实测通过：deepseek-v4-pro/flash 均一轮即发 tool_calls、回填后继续生成、干净收敛（turns=2, stopReason=no_tool_calls） | ⚠️ 不直接支持 OpenAI 协议；仅当厂商提供 Anthropic 兼容端点（DeepSeek 有，已实测 200 + tool_use；豆包/通义无） |
| 步骤内预算上限 | 高 | ✅ 实测：maxTurns=1 干净停（stopReason=max_turns） | ✅ maxTurns / maxBudgetUsd（配置面确认） |
| 维护成本 | 高 | 全白盒；spike 192 行（核心 ~80 行），产线估 350-450 行 | node_modules **265 MB**（212 MB 为捆绑的 Claude Code 二进制）；行为随上游演进不受控 |
| 接薄云中转计费 | 中 | 原生——baseURL 即中转，全部国产厂商说 OpenAI 协议 | 中转必须说 Anthropic Messages 协议 → 供应商锁定在有 shim 的厂商 |
| 开发速度 | 中 | spike 当天跑通同一英雄流程切片 | 起步快，但活体运行被 OAuth 机制阻塞（凭据刷新依赖桌面 IPC） |

## 决定性因素

1. **265 MB 引擎依赖对消费级桌面应用不可接受**：Electron 壳本身 ~200MB，叠加后安装包逼近 500MB——直接打击 §9 已知的下载转化漏斗。
2. **协议通用性**：自研 loop 说所有国产厂商的母语（OpenAI 兼容）；SDK 路线把可选厂商集合缩小到"提供 Anthropic shim 的"，与 §9 强弱模型多厂商路由冲突。
3. **质量无差**：deepseek-v4 双档在同一切片上都产出可用口播稿，5 条 writingRules 全部遵守；flash 更快（18.4s vs 24.0s）。

## 可逆性

低切换成本：loop 的接口本质是 messages + tools。若未来需要 SDK 的长会话能力（压缩、子代理），替换 loop 实现层即可，外层状态机与工具定义不动。

## 意外发现（重大，回写 §9）

- **单位经济比 PRD 预估好两个数量级**：完整英雄流程切片 ~1.8-2.1K tokens / 次，DeepSeek 上成本 < ¥0.001。§9 按 Claude 级模型估的日更用户月 COGS ¥55-75，在 DeepSeek 路由下坍缩为 ~¥0.1 量级。39 元定价毛利空间充裕，免费层成本敞口风险大幅缓解。
- **deepseek-v4-flash 质量达标且更快**：强弱路由里弱档可承担的工作比预想多（过滤/排版/打标之外，部分生成也可下放）。
- **DeepSeek 提供 Anthropic 兼容端点**（api.deepseek.com/anthropic/v1/messages，含 tool_use）：备用路线存在，进一步降低自研 loop 的风险（极端情况下 SDK 兜底可用）。

## 解锁

- 计划 4（薄 loop 引擎 + 进程内生成）可以编写——参考实现：`spikes/thin-loop/loop.mts`（192 行，标注可丢弃，不许 import 进 src/，仅作形状参考）。
- PRD §14 Q4 划掉；§9 单位经济段补注 DeepSeek 实测数据。
