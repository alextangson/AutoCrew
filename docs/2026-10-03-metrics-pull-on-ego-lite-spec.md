# 数据回流改走 ego lite — 规格（已确认）

2026-10-03。创始人裁定：三平台数据回流从 chrome-cdp 迁到 ego lite。

## 为什么

- 回流（2026-08-23）照搬公众号拉数，连常驻 chrome-cdp（`127.0.0.1:18792`，原由 `ai.openclaw.chrome-cdp` 托管）。这台机器上没有这个服务，回流从没跑起来过。依赖外部脚本也违反 AGENTS.md「自带安装」。
- 发布（2026-09-05 起）用 ego lite。2026-10-03 只读探查：ego lite 里抖音、视频号、小红书创作者后台都已登录（打开后台首页没有跳登录页）。

## 改什么

只换「浏览器连接」这一层，平台接口和数据解析不动。

1. 新增 ego lite 通道：后端起 `ego-browser nodejs` 子进程，脚本在一个 TaskSpace 里打开平台后台页，用 `page.fetch()` 在页面里带登录状态请求接口，把 `{httpStatus, finalUrl, contentType, bodyText}` 原样交回（和现在 `PageFetchResponse` 一致）。
2. 抖音 / 视频号 / 小红书三个抓取器改用这个通道；判定逻辑（登录跳转 = 需扫码、JSON 解析失败 = 接口变了零写入、风控）保持现状。
3. 每次抓取结束都关掉自己开的页（`finish({ keep: [] })`），异常路径也关。
4. 公众号拉数（`wechat-mp-stats.ts`）一并迁过去，去掉最后一处对 chrome-cdp 的依赖。
5. 清理指向 openclaw 的说明：`cdp-session.ts` 头注释、`src/desktop/wechat-pull.ts:17` 的 LOGIN_HINT（指向 `~/.openclaw/.../pull_wechat_stats.py`）、`PullStatusPanel.tsx:126`、`pull-lib.ts:108`、`docs/metrics-autopull-spec.md:48`、`docs/dogfood-runbook.md:721/739`。
6. `autocrew doctor` 加一项：`ego-browser` 命令在不在、能不能连上 ego lite。
7. 删除 chrome-cdp 通道代码（不留双通道开关）。

## 节奏（提议改）

现状：30 分钟检查一次；同平台两次抓取至少隔 12 小时；每平台每天最多自动 2 次。

提议：**每天固定 9:00 自动抓 1 次**（三平台串行，间隔 ≥10 秒）；错过 9:00（电脑睡眠 / 服务没开）就在下一次检查时补抓，当天只补一次。手动「立即抓取」不受限制。理由：对账只要 T+3、D+7 读数，一天一次足够；ego lite 里开关标签页一天最多 3 次。

## 边界情况（即验收清单）

- ego lite 没开 / `ego-browser` 不在：状态写「浏览器未连接（ego lite）」，Report 页给指引；不重试刷屏，当天按退避规则走。
- 平台登录过期：跳登录页 → `needs_login`，待办写「在 ego lite 里登录 XX 后台」，当天不再碰。
- 风控 / 验证码：当天停，次日再试（现状保留）。
- 创始人正在用 ego lite：只在 Agent 自己的 TaskSpace 里开页，不碰用户的标签；抓完就关。**是否会抢焦点 / 弹到前台：未验证，实现时实测，若会抢焦点要报告**。
- 子进程卡死：单次抓取有总超时（沿用现有超时），超时杀进程并记失败。
- 并发：手动抓取和定时抓取同平台不并发（现有 single-flight 保留）。
- `ego-browser` 输出不是预期 JSON：当作通道故障，零写入，状态可见，不当空数据。
- 已开的回流开关（`metrics-pull.json` 三平台 enabled）沿用，不需要重开。

## 不做

- 不新增抓取平台（B 站等）。
- 不改数据解析、绑定、复盘口径。
- `~/.autocrew/chrome-cdp-profile`（今天临时建的、没登录）保留不动。

## 创始人裁定（2026-10-03）

1. 节奏：每天 9:00 自动抓 1 次；错过就在下一次检查时补抓，当天只补一次；手动不受限。
2. 边界情况全部确认，即验收清单。
