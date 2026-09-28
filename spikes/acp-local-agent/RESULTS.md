# 阶段 0 spike 结果（2026-09-28）

脚本：`node spike.mjs <claude|codex|workbuddy> [--auth-fail]`（自带一个校验 `Authorization: Bearer` 的最小 http MCP）。
运行环境：`env -i HOME PATH USER`（去掉宿主会话继承的 CLAUDE_CODE_* / ANTHROPIC_BASE_URL，模拟守护进程环境）。
客户端：`@agentclientprotocol/sdk` 1.5.1。

## 结论：阶段 1 被挡住——本机 Claude 登录已过期

`claude -p "say hi"`（CLI 2.1.282，干净环境）同样报 `Failed to authenticate: OAuth session expired and could not be refreshed`。
钥匙串里有 `Claude Code-credentials` 条目，但刷新失败。需要创始人在终端跑一次 `claude` 重新登录（我不代为登录）。
登录前 Claude 的权限 / cancel / session/load 全部无法验证，按约定停在这里。

## Claude — `@agentclientprotocol/claude-agent-acp` 0.81.2

| 检查 | 结果 |
|---|---|
| initialize | 通过；agentInfo 0.81.2，loadSession=true，mcpCapabilities.http=true，authMethods=[]（空） |
| session/new 带 http MCP + Authorization 头 | 通过（不需要登录即可建会话） |
| prompt 流式 + MCP 调用 | 未验证：登录过期 |
| request_permission 允许/拒绝 | 未验证：登录过期 |
| cancel | 未验证：登录过期 |
| 杀进程后 session/load 续 | 未验证：登录过期 |
| 认证失败长什么样 | **已观察**：initialize、session/new 都成功；第一次 `session/prompt` 才失败，JSON-RPC 错误 `Internal error: Failed to authenticate: OAuth session expired and could not be refreshed`。authMethods 为空，客户端无法走 ACP authenticate，只能提示用户在终端跑 `claude` 登录。就绪检测因此不能只靠 initialize。 |

怪癖：从 Claude Code 会话里直接起适配器会继承 `ANTHROPIC_BASE_URL` 等宿主变量；守护进程起 agent 时要给干净环境。

## Codex — `@zed-industries/codex-acp` 0.16.0（npm 已标 deprecated，改名 `@agentclientprotocol/codex-acp`）

| 检查 | 结果 |
|---|---|
| initialize | 通过；loadSession=true，mcp http=true，authMethods=chatgpt / codex-api-key / openai-api-key |
| session/new | **失败：60 s 超时**，原因未诊断（疑似启动 MCP 客户端或登录态检查卡住） |
| 其余 | 因 session/new 失败未能验证；session/load 返回 `Invalid params` |

阶段 2 前要先诊断 session/new 超时，并评估是否换成改名后的 `@agentclientprotocol/codex-acp`。

## WorkBuddy — App 自带 `codebuddy --acp`

| 检查 | 结果 |
|---|---|
| initialize | 通过；loadSession=true，mcp http=true，authMethods=iOA / external / internal / selfhosted；无 agentInfo 版本 |
| session/new | 通过 |
| MCP 调用 | **失败**：MCP 服务没收到调用 |
| 允许/拒绝 | 未触发 request_permission，文件也未写出——agent 其实没干活 |
| cancel | prompt 立刻返回 `stopReason: "refusal"`（0 ms），不是真 cancel |
| session/load | 续会话后回答为空 |

判断：每个 prompt 都直接 `refusal`，最可能是 CLI 没有独立登录态（需要走 authMethods 之一），尚未确认。阶段 2 前要诊断。

## 未做

- 三家的“真实结果”都缺登录态这一前提；Claude 登录恢复后需重跑 `node spike.mjs claude`，再决定是否开建阶段 1。
