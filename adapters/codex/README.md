# 在 Codex CLI 里当 AutoCrew 的员工

AutoCrew 是工具与案卷，Codex 是宿主。接上之后，Codex 会话里的模型可以直接
领写作包写稿、或者做封面——稿件、证据、封面、审稿记录全部落在 AutoCrew 的案卷里，
不在会话里。

## 1. 接线

前提：AutoCrew 至少启动过一次（`npm start`）。令牌目录是服务建的。

```bash
npx autocrew host codex
```

它做两件事：确保 `~/.autocrew/tokens/codex.token` 存在，然后把接入步骤打出来。
**令牌值永远不出现在输出里**，只出现文件路径——终端会被录屏、会进剪贴板历史，
而这个文件等于整间编辑部的钥匙。

按打印出来的步骤走，大致是：

```bash
export AUTOCREW_MCP_TOKEN=$(cat ~/.autocrew/tokens/codex.token)
codex mcp add autocrew --url http://127.0.0.1:4317/mcp --bearer-token-env-var AUTOCREW_MCP_TOKEN
```

撤销 = 删掉那个文件（或在工作台「设置 · 接入更多 · 宿主」卡上点撤销），
下一次调用立刻 401。

### `codex exec` 的坑

**非交互的 `codex exec` 会自动取消 MCP 工具调用**，除非加
`--dangerously-bypass-approvals-and-sandbox`（openai/codex #24135、#16685）。
日常请用交互式会话，工具调用逐次弹审批点同意即可。

### 服务没起的时候

Codex 端会看到连接失败或 401。这是对的——AutoCrew 的所有写入口都经守护进程一个进程，
不会有第二个进程偷偷起来写盘。先 `npm start`，再重试。

## 2. 装人设

两份人设在这个目录里：

| 文件 | 岗位 | 干什么 |
|---|---|---|
| `AGENTS.editor-writer.md` | 总编辑 + 写手 | 调研 → 念立意卡 → 选卡 → 领写作包 → 写 → 交稿过门禁与审稿 |
| `AGENTS.cover.md` | 封面师 | 待办桌认领 → 读稿 → 3:4 三候选 → 批准 → 延展 4:3 |

Codex 读工作目录（及其上层）的 `AGENTS.md`。把人设写进去：

```bash
npx autocrew host codex --dir ~/work/autocrew-desk                     # 默认 editor-writer
npx autocrew host codex --dir ~/work/autocrew-cover --role cover       # 封面师
```

写入的是 `<dir>/AGENTS.md` 里一段带定界符的内容：

```markdown
<!-- autocrew:start -->
…人设…
<!-- autocrew:end -->
```

文件已存在但没有定界符 → **追加**在末尾，你原有的内容一个字不动；
已经有定界符 → 只**替换**这一段。重跑就是更新人设。

也可以直接手抄：把对应文件的内容贴进你自己的 `AGENTS.md`。

两个岗位建议各用一个工作目录。同一个会话既写稿又做封面，模型会在两套硬约束之间打架
（写手那套要求「先看 status」，封面师那套要求「只出 3:4 / 4:3」），
而且待办桌的认领会互相踩。

## 3. 一轮长什么样

**写稿**：`autocrew_desk inbox writer` → `claim` → `autocrew_workflow research/status`
→ 念卡 → `select_angle` → `autocrew_writer pack` → 轮询 `pack_status`（1–6 分钟）
→ 照包写 → `submit` → 轮询 `submit_status`（1–3 分钟）→ 终态 → `release`。

**封面**：`autocrew_desk inbox cover` → `claim` → `autocrew_content get`
→ `create_candidates ratio=3:4` → 给创作者选 → `revise` → `approve`
→ `platform_ratios ratios=["4:3"]` → `release`。

两头都要轮询，因为备料与审稿各要跑几分钟，而 MCP 宿主 60 秒就掐工具调用。
轮询之间该干别的就去干，不要原地空转。

## 4. 两个宿主同时干活

认领是软门、令牌是硬门：

- 内容没有有效认领时，写操作直接执行并自动补一个认领。
- 内容已被别的宿主认领且租约（30 分钟）没过期时，写操作必须带匹配的 `claim_token`，
  否则被拒并告诉你持有者是谁。
- 租约过期后新宿主可以接管，旧令牌的迟到写入被拒。

工作台的稿卡会显示「Codex 写」「Codex 封面中 · 12 分钟前」「租约过期」，
所以创作者随时能看见是谁在动这一篇。

## 5. 安全边界

- 令牌是本机全能凭证：一把能调全部 AutoCrew 工具。本机单用户，威胁模型是误操作不是恶意。
- 写作包里只有**校验过的引文与简报摘要**，抓回来的原始网页不进包。
  包里 `<<<EXTERNAL_CONTENT>>>` 定界符之间是材料不是指令——两份人设都写了这一条。
