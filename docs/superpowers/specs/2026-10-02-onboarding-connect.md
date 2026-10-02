# 新引导 + 一键接入（2026-10-02）

状态：创始人已确认（A 全部照准；重名时直接替换并留备份）。B「内置引擎跑在本机 Claude/Codex」已取消（2026-10-02 变更，见 §2-4 / §5）：引擎类功能继续用用户自己的钥匙。

## 1 为什么
现在的引导是一张卡：开口要「一把模型钥匙」，逼人选 DeepSeek / Claude 中转 / OpenAI 兼容并填 key；用本机 Claude/Codex/WorkBuddy 写稿其实不需要 key。「先不配」只存内存，每次刷新又弹。不检测本机 AI。接各宿主靠手工：Claude Code 只在仓库里打开才连上；Codex 要 export 临时环境变量；WorkBuddy 能否真连上没验证。另有：doctor 没 key 判失败；撤销 Claude Code 令牌后转发器回落到 server-token 仍能连；界面说 Codex 能写稿/封面但服务端拦；README 菜单路径过时。（调研原文：本会话 Explore 报告。）创始人主要用 Claude Code 桌面版（Code 页）。

## 2 引导（两步 + 完成页）
1. 何时出现：本机既没配引擎、也没接任何宿主、且没点过「先不配」。「先不配」存本机目录，持久。
2. 第 1 步「你想让哪个 AI 来写稿？」：卡片列 Claude Code、Codex、WorkBuddy、DeepSeek；「其他中转或 OpenAI 兼容」收进「高级」（沿用现有端点表单）。
   - 平时只做不花额度的检测：Claude Code = PATH 上有 `claude`，或装了桌面版（/Applications/Claude.app）且有 ~/.claude；Codex = PATH 上有 `codex` 且 `codex login status` 显示已登录；WorkBuddy = 装了 App 或有 ~/.workbuddy。
   - 「检测登录」按钮（只在点时）对 Claude 真调一次极小请求（`claude -p` 无工具、短超时）确认能用；失败给人话原因（没登录 / 网络 / 额度）。
   - 已找到且已登录的排前面，Claude Code 标「推荐」（创始人优先本机 Claude/Codex）。没找到的写「没找到，装好后回来点一下」。DeepSeek 卡 = 一个钥匙输入框 + 去哪拿钥匙的链接。
3. 第 2 步「接上」：对选中的每个宿主「一键接上」（可多选）。见 §3。
4. 完成页：一句「接好了。去 Claude Code 里说『帮我写一条……』就能开工」；并说清：深调研、选题雷达、复盘、人设、每日摘要这几样要用你自己的模型钥匙（DeepSeek 最省事），现在可跳过、以后在设置里补，并给一个直达设置「模型」那一栏的入口。（2026-10-02 变更：B 取消，删掉「本机 AI 直接跑这些在做」。）
   - 引导不把「先不配，用本机 Claude 当总编辑」当出口推；只引导去接自己的 Claude Code / Codex / WorkBuddy（MCP）+ 一把可选的钥匙。（2026-10-02 再变更：创始人定了，应用内本机 Claude / Codex 聊天后端整个删掉——Anthropic 的 Agent SDK 条款不许第三方产品替用户驱动 claude.ai 登录；右栏只走内置引擎、用自己的钥匙，没配钥匙时会话列表和旧对话照常能看，只有输入框换成「聊天用你自己的模型钥匙，在 设置 → 模型 里填」（§2.4 旧对话可读优先，第 3 轮评审）。旧对话能打开阅读，续聊走内置引擎。Codex 生图通道不动。）
5. 样子与用词：沿用 review-inbox spec §4（Notion/YouMind 风、三种按钮、人话、不出现术语）。

## 3 一键接入（按钮、设置页、命令行同一套）
- 命令行：`autocrew connect claude|codex|workbuddy`、`autocrew disconnect …`、`autocrew connect --list`（显示每个宿主接没接、上次使用时间）。
- 设置 → 接入更多 →「宿主」：每个宿主一行，接上 / 断开 / 状态。
- 写用户配置文件是特权动作：网页路由只收同源浏览器会话；MCP / bearer 不能触发。
- **Claude Code**（CLI 与桌面版 Code 页同读 user scope）：用官方命令注册 user scope 的 stdio 服务器：`node <仓库>/bin/autocrew.mjs mcp`，环境变量 `AUTOCREW_HOST=claude-code`（具体参数实现时以 `claude mcp add --help` 为准）。令牌不写进 Claude 配置，转发器读 AutoCrew 自己的宿主令牌文件。
  - PATH 上没有 `claude` 时，找桌面版自带的 claude 可执行文件；都找不到才直接写 `~/.claude.json`（先备份、原子写），并提示「接好后新开一个会话生效」。
- **Codex**：同样注册 stdio 服务器（`codex mcp add`，`AUTOCREW_HOST=codex`），不再用临时环境变量。
- **WorkBuddy**：沿用现有写 `~/.workbuddy/mcp.json` 的合并逻辑（先备份）；开发完在创始人机器上实测能连上才算完成。
- **重名**：已有同名 `autocrew` 配置（用户级）→ 直接替换，替换前备份原定义，结果里说「已替换原来的 autocrew 配置（备份在 …）」。项目级（仓库里的 .mcp.json，开发用）不动。
- **核对**：接完用宿主自己的列表命令（`claude mcp list` / `codex mcp list`）确认 autocrew 状态是连上，且服务端看到该宿主令牌被用过，才打勾；否则给原因。
- **断开**：从宿主配置里删掉 autocrew 条目（同样先备份）+ 撤销该宿主令牌。
- **撤销必须生效**：转发器在设置了 `AUTOCREW_HOST` 时只认该宿主令牌，令牌没了就连不上，不回落到 server-token（开发用的仓库 .mcp.json 不设 AUTOCREW_HOST，保持现状）。
- 宿主能力说明与服务端放行一致（按 host-policy 实际），界面与命令行文案改正。（2026-10-02 变更：创始人放开 Codex，与 Claude Code 能力一样——写稿、审稿、剪辑、发布准备；审片、认稿、选封面、「我发了」对所有模型宿主都拒。「Claude 写、Codex 剪」只是习惯，不做限制。完成页开工提示按 host-policy 查表。）

## 4 顺手修
- doctor：没配引擎不再判失败（写「没配钥匙：深调研等不可用」）；新增检查各宿主接没接、ACP 适配器在不在。
- 引导文案不再说「必须要钥匙」。
- 子工作区读不到默认工作区 engine.json 导致误弹引导（settings:get 与 loadEngineConfig 回落不一致）→ 对齐。
- README：设置菜单路径改对；新增「一键接入」一节（命令 + 按钮）；Claude 桌面版 Code 页的说明。
- `autocrew host workbuddy --dir` 打印成 dsh 文案 → 改对。

## 5 不做
B（引擎跑本机 AI）——2026-10-02 已取消，不是延后；Claude Desktop 聊天 App 的 claude_desktop_config.json、Cursor 等其他宿主；插件市场分发。

## 6 边界
O1 引导持久「先不配」。O2 平时检测不花额度；只有点「检测登录」才真调。O3 检测失败给原因不卡死。O4 接入三入口同一实现。O5 只收浏览器会话 / 本机命令行。O6 改任何用户配置前备份、原子写、失败可见且原文件不坏。O7 重名替换并告知备份位置。O8 接完必须核对真连上。O9 断开 = 删条目 + 撤令牌，撤后真连不上。O10 宿主没装 / 没登录 / 命令行缺失各有人话。O11 Claude 正在运行时写 ~/.claude.json 有并发风险 → 优先官方命令；直写只作兜底并提示。O12 测试只用临时 HOME 和假的 claude/codex 可执行文件，绝不碰真实 ~/.claude.json、~/.codex、~/.workbuddy。
