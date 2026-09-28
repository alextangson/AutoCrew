# 阶段 0 spike 结果（2026-09-28）

脚本：`node spike.mjs <claude|codex|workbuddy> [--auth-fail]`（自带一个校验 `Authorization: Bearer` 的最小 http MCP）。
运行环境：`env -i HOME PATH USER`（去掉宿主会话继承的 CLAUDE_CODE_* / ANTHROPIC_BASE_URL，模拟守护进程环境）。
客户端：`@agentclientprotocol/sdk` 1.5.1。

## 结论（更新）

- **Claude：阶段 1 可开建。** 登录已由创始人恢复；重跑除权限外全过。权限问题已解（见下）。
- **Codex：已定案**，锁 `@zed-industries/codex-acp` 0.16.0，每个会话强制 `-c approval_policy="untrusted" -c sandbox_mode="workspace-write"`（不管用户全局配置），界面滤掉“总是允许”，session/new 超时 ≥90 s。阶段 2 接。
- **WorkBuddy：推迟到阶段 2 待决策。** App 自带 CLI 只能无头运行（交互模式回落到不存在的 `dist/codebuddy`），创始人无法 `/login`；`ACC_PRODUCT_CONFIG_PATH=product.json` 仍报需登录。两条路待定：装独立的 `@tencent-ai/codebuddy-code`（自带登录）；或像 ChatCut 那样反向“复制提示词”。未读取任何已存令牌。

## Claude — `@agentclientprotocol/claude-agent-acp` 0.81.2

| 检查 | 结果 |
|---|---|
| initialize | 通过；loadSession=true，mcp http=true，authMethods=[] |
| session/new 带 http MCP + Authorization | 通过 |
| prompt 流式 + MCP 调用 | 通过（登录恢复后重跑） |
| cancel | 通过 |
| 杀进程后 session/load | 通过 |
| request_permission 允许/拒绝 | 默认**不发**；按下法修复后**通过** |
| 认证失败 | initialize、session/new 都成功，第一次 `session/prompt` 才报 JSON-RPC `Internal error: Failed to authenticate: OAuth session expired and could not be refreshed`。authMethods 为空，只能提示用户在终端跑 `claude` 登录；就绪检测不能只靠 initialize |

**权限不发的根因**：创始人 `~/.claude/settings.json` 里 `permissions.allow = ["Bash(*)","Read(*)","Write(*)","Edit(*)"]`，默认 mode=default 下这些工具直接放行，canUseTool 根本不被调用。
（协调方试过的项目级 `.claude/settings.json` 放在 spike 暂存目录里，而 `spike.mjs` 每次启动会 `rmSync` 清空该目录——试验大概率被自己删掉了，不能据此判定项目级无效。）

**修法（已验证，`probe-claude-perm.mjs flag-ask allow|reject`）**：session/new 时传
`_meta.claudeCode.options.settings = { permissions: { ask: ["Bash","Write","Edit","MultiEdit","NotebookEdit"] } }`。
适配器把它作为 SDK 的 flag settings（最高优先级来源）转发，`ask` 压过用户的 `allow`：
- 拒绝：收到 `allow-once:allow_once / reject:reject_once`，选 reject → 文件未写出；
- 允许：同样选项，选 allow-once → 文件写出；
- 不改全局设置，`settingSources` 仍是 user/project/local：agent 仍看得到创始人全局 CLAUDE.md（实测回答 yes 并引用“默认用中文回复”），技能/记忆不丢，登录（钥匙串）不受影响。无需单独 CLAUDE_CONFIG_DIR。
- 可用 modes 含 bypassPermissions，守护进程永不 setSessionMode；另传 `allowDangerouslySkipPermissions:false` 关掉旁路模式。

## Codex — `@zed-industries/codex-acp` 0.16.0（npm 已标 deprecated，改名 `@agentclientprotocol/codex-acp`）

读的就是 `~/.codex`（auth.json 的 ChatGPT 登录可用，无需额外登录）。

| 检查 | 结果 |
|---|---|
| initialize | 通过；loadSession=true，mcp http=true，authMethods=chatgpt / codex-api-key / openai-api-key |
| session/new | 通过（6–13 s）。首跑 60 s 超时**未复现**；它会连带启动 `~/.codex/config.toml` 里用户自己的 MCP（node_repl、computer-use、chatcut、autocrew 等），冷启动慢是最可能原因。我们的 spike MCP 不是阻塞点（指向不可达端口也 6.7 s 返回）。实现时 session/new 超时要放宽到 ≥90 s |
| MCP http + Authorization | 通过：带头调到 spike_ping |
| 流式 update | 通过：agent_message_chunk / tool_call / tool_call_update / usage_update |
| request_permission | **默认不发**。根因：用户 `~/.codex/config.toml` 是 `approval_policy="never"` + `sandbox_mode="danger-full-access"`，会话初始 mode=full-access，shell 直接执行（拒绝测试时文件照样写出）。切 mode auto / read-only、`-c approval_policy="on-request"` 都不发。**只有 `-c approval_policy="untrusted" -c sandbox_mode="workspace-write"` 启动时才发**，选项为 `approved:allow_once` / `approved-execpolicy-amendment:allow_always` / `abort:reject_once`；允许→文件写出，拒绝→未写出。阶段 2 必须带这两个 -c 启动、不调 setSessionMode，并在界面过滤掉 allow_always |
| cancel | 通过：stopReason=cancelled，5 ms；被取消的 `sleep 60 && echo` 没有写出文件 |
| 杀进程后 session/load | 通过：新进程 load 后能答出上文的 bluebird-42。首跑的 `Invalid params` 是因为 session/new 超时、会话根本不存在；同一进程里对刚建的会话再 load 返回 -32002 Resource not found（首轮前未落盘），属正常 |
| 模型 | 默认 gpt-6-astra，会打 “Model metadata … not found, fallback” 警告，不影响回答 |

**改名包 `@agentclientprotocol/codex-acp` 1.13.1 对比**：initialize/session/new 正常，modes 变成 read-only / agent / agent-full-access，多了 reasoning_effort、fast-mode 等配置项；但默认、`-c approval_policy="untrusted"`、切 read-only 三种情况下**都没发 request_permission，文件照样写出**（read-only 也写出了，疑似被用户全局 danger-full-access 覆盖，未深究）。→ 阶段 2 锁定 0.16.0（虽 deprecated），或另查 1.13.1 的审批开关。

**创始人要做的**：无（登录态现成）。决定是否接受“Codex 走 0.16.0 + untrusted 启动参数”。

## WorkBuddy — App 自带 `codebuddy --acp`

根因已确认：**CLI 没有登录态**。干净环境跑 `codebuddy -p "say hi"` 直接返回 `Authentication required. Please use /login command to sign in to your account`。
WorkBuddy App 的登录（`~/Library/Application Support/WorkBuddy`）不会共享给 CLI；CLI 自己的目录 `~/.codebuddy` 里有 sessions/logs/user-state.json，但没有凭据。
`--help` 没有 login/auth 子命令，只能在交互式 `codebuddy` 里用 `/login`；ACP 侧 authMethods=iOA / external / internal / selfhosted。
ACP 里未登录的表现：initialize、session/new 成功，每次 prompt 立刻 `stopReason: "refusal"`（不是 JSON-RPC 错误），所以之前的 MCP / 权限 / cancel / load 结果全部无效。
另：`--permission-mode` 可设 default / acceptEdits / plan / dontAsk / auto / bypassPermissions，阶段 2 用 default 验证是否发 request_permission。

**创始人要做的**：终端运行 `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`，在里面 `/login`（选你 App 用的那种登录方式），之后重跑 `node spike.mjs workbuddy`。就绪检测要把 `refusal` 识别成“未登录”。

## 诊断脚本

- `probe-new.mjs <adapterBin> <0|1>`：计时 session/new（可带不可达 MCP），打印 stderr 尾部。
- `probe-modes.mjs <adapterBin> [mode] <allow|reject>`，`ARGS` 环境变量传启动参数：列 modes/config，跑一次 shell 写文件看是否发权限请求。

## 未做

- WorkBuddy：等 CLI `/login` 后重跑。
- Codex 1.13.1 的审批开关没查到底。
