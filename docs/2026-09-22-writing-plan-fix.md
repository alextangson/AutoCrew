# AutoCrew 文案规划传递修复

已修复代码并重启本地服务。2026-09-22 对运行中的 `http://127.0.0.1:4317/mcp` 做只读检查，三个写作入口均已暴露 `requirements`，HTTP 200。

## 问题与结果

| 原问题 | 修改后 |
| --- | --- |
| 创作者档案保存了内容定位、表达定位和视频时长/字数，写手没有完整收到 | 写作、审稿和改稿使用同源上下文；实际档案装配检查全部通过 |
| 本次提纲、必写/禁写、篇幅只能挤进角度或研究材料 | `requirements` 独立承接完整要求，保留已选立意；`direction` 继续仅在主动换方向时使用 |
| 重新领包可能无声返回旧要求 | 新要求、资料、选题描述、已选立意、档案变化会明确返回换包提示；`force:true` 重建，不自动增加模型调用 |
| 审稿拿不到手写方向和完整规划 | 写手、审稿、自动修订共享 `writingContract`，并随成稿保留 |
| 改稿只看当前反馈，下一轮可能改回旧方向 | 成功采纳的反馈按整篇/选区范围保存，后采纳要求优先；未采纳建议不记入 |
| 历史自动提炼规则与明确要求同权重，且固定信息点数量催生模板腔 | 明确优先级，自动提炼规则仅作条件参考，取消固定数量和逐段三段式 |
| 小红书/视频号/B站把发布简介上限用于口播全文 | 口播按创作者规划写；发布前对同平台 `videoKit.caption` 保留原上限，公众号全文门禁不变 |

事实、数字证据、格式、角度点选、认领和发布审批门禁继续保留。选题描述可能来自搜索摘要，带外部材料边界，不自动升级为作者指令。

## 使用约定

- 新稿：将本次完整要求放入 `requirements`。未重新指定的档案偏好继续生效。
- 改要求或更新档案后，收到 `pack_request_changed` 时使用 `force:true` 重新领包；不能拿旧包继续写。
- 从手写方向改回已选立意卡时，显式传 `direction:""` 清掉旧方向。
- 已经发出的旧写作包不会被偷偷重写；需要新规则时重新领包。没有历史规划记录的旧成稿无法凭空恢复原始要求。
- 编辑器采纳修改和整篇改稿保存会保留已采纳反馈；直接改文件或仅给 `content update` 写版本备注不会被猜成新的写作规划。

## 原本地集成版本验证

- 相关回归：40 个测试文件，766 项通过，全程模型替身和隔离目录。
- 全量测试：4648 项通过，1 项视频测试在并发清理临时目录时出现 `ENOTEMPTY`；该测试单独复跑通过。没有为此修改视频代码或放松断言。
- TypeScript 检查通过；修改涉及的生产文件 ESLint 0 error，9 项已有 warning。
- 前端构建通过，有现有 config.js 和包体积提示。
- 当前真实创作者档案的只读装配检查：定位、表达、字数、时长、本次要求、审稿合同与偏好分层均通过。
- 重启后在线 MCP 的 writer/workflow/generate 均包含新参数；未生成或覆盖用户已有文案。

以上验证证明规划传递和约束生效，不等于真实模型出稿已通过创作者品味验收。本轮没有发起真实文案生成或发布。

## GitHub 独立上传版本验证

本次上传分支 `codex/writing-plan-fix` 基于 GitHub `main` 的 `4daf13b`，仅移植本次文案修复及必要兼容调整。未包含本地先前的七个提交、调研资料、引擎可选配置变更或未提交的封面改动；上述本地服务与全量测试结果不能代替本分支验证。

- 本分支相关回归：41 个测试文件、808 项通过，覆盖写作、改稿、MCP、桌面采纳、存储、创作者档案、赛道包、宿主适配和前端选区处理；均使用模型替身或隔离数据。
- TypeScript 检查通过；涉及的后端与适配器生产文件 ESLint 0 error、9 项已有 warning。
- 前端构建通过，保留现有 config.js 和包体积提示。
- 独立分支未重跑全量测试、未替换正在运行的本地服务、未发起真实模型出稿。分支上传不会触发现有仅面向 main 推送及 PR 的 GitHub CI。

复现命令：

```sh
npm run typecheck
npx vitest run src/modules/writing src/tools/writer.test.ts src/tools/workflow.test.ts src/tools/generate.test.ts src/tools/pre-publish.test.ts src/desktop/adopt-revision.test.ts src/tools/persona-capabilities.test.ts adapters/dsh/src/preset-install.test.ts --maxWorkers=4
npx vitest run src/storage/local-store.test.ts src/storage/local-store-security.test.ts src/modules/profile/creator-profile.test.ts src/modules/packs/pack-schema.test.ts src/modules/packs/text-platform-packs.test.ts src/modules/packs/wechat-article.test.ts src/desktop/ipc.test.ts src/desktop/revise-focus-tool.test.ts mcp/server.test.ts adapters/dsh/src/tools.test.ts frontend/src/apply-span.test.ts frontend/src/revision.test.ts --maxWorkers=4
npm run fe:build
```
