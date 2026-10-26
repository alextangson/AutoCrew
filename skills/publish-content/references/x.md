# X 操作（英文版）

> **已实测（2026-10-26，@LawrenceTangAI，Premium，第一次定时发布全程走通）**：表里「实测」处是当时观察到的控件和故障。页面改版后，以当下的 snapshot 为准。
>
> **通用坑**：发帖弹窗里的按钮（Content disclosure、Schedule post、最后的 Schedule）经常被一层全屏透明 div 挡住，鼠标点击和坐标点击都会落空。可靠的做法是 `page.focus(<按钮>)`，确认 `document.activeElement` 就是这个按钮，再按一次 Enter。

入口：https://x.com/compose/post

发的是英文版那条稿（`en_edition` 派生稿）。英文版不走中文登记：只按**批过的英文发布包**发。先调 `autocrew_publish {action:"ego_lite_prepare", content_id:<英文版>}`（不带 check_ids），回执里每个平台的 `video_path` / `thumbnail_path` / 文案就是要上传和粘贴的东西，记下 `package_hash`；回 `en_package_not_approved` 就停下，请创始人在「等你拍板」里批英文发布包（批过之后改过也会回到那里，原因写在那件里）。X 用 `platform:"x"` 那一项：`post_text`（≤280 字符，标签已并进去）、`video_path`。默认时段：**北京时间 21:00–23:00（美国上午）**。

| 步骤 | 动作 | 成功条件 / 已知故障 |
|---|---|---|
| 账号 | 核对左下角头像的 @用户名 | 与发布计划一致；长视频要 Premium 账号。**没登录：停下请创始人登录**，不跳过。实测：`[data-testid=SideNav_AccountSwitcher_Button]` 里是显示名和 @handle，带 `icon-verified` 蓝勾；没登录时 `/home` 会跳到 `/i/jf/onboarding/web?...mode=login` |
| 写帖 | 正文框清空后粘发布包原文 | 读回全文一致；右下字数圈没变红。实测：`/compose/post` 页面上有两个发帖框（弹窗一个、首页内嵌一个），选择器一律加 `[role=dialog]` 前缀。正文框是 `[data-testid=tweetTextarea_0]`（Draft.js），用 keyboard.paste 粘贴；读回时 innerText 会把空行多算一个 `\n`，要按 `[data-block=true]` 逐块取 textContent，再用 `\n` 拼起来比对 |
| 视频 | 「媒体」按钮选登记的英文成片 | 等上传进度走完、出现视频预览；超出账号的时长 / 大小上限会直接报错——**原样记下报错，停下告诉创始人**，不压缩、不换文件。实测：直接对 `[role=dialog] input[data-testid=fileInput]` 做 setInputFiles。423MB、11 分钟的视频，Premium 账号能收，状态行显示「<文件名>: Uploading (N%)」，中途偶尔会退回几个百分点；**一共花了约 50 分钟**，然后依次显示 Processing、Ready。等的时候别动弹窗 |
| AI 标注 | 工具栏的「Content disclosure」（旗子图标） | 实测：里面有两个开关，「Paid partnership」和「Made with AI」（`[role=switch]`）。英文版用了 AI 配音，2026-10-26 照 YouTube「AI use = Yes」的决定开了「Made with AI」。这一项**应该写进英文发布包**；包里没有就问创始人。点 Done 后，发帖框里会出现「Made with AI」 |
| 定时 | 「安排」（日历图标）设到计划的日期时间 | 读回日期、时间和时区，换算成北京时间核对；按钮变成「安排」而不是「发帖」。实测：日历按钮是 `button[aria-label='Schedule post']`，打开后网址是 `/compose/post/schedule`。月、日、年、时、分是五个原生 select（`select[aria-labelledby=SELECTOR_1..5_LABEL]`，小时是 24 小时制），用 selectOption 设。读回「Will send on Mon, Oct 26, 2026 at 9:30 PM」，时区写的是「Taiwan Standard Time」（UTC+8，没有夏令时，等于北京时间）。点 `scheduledConfirmationPrimaryAction`（Confirm）回到发帖框，顶部会显示「Will send on …」，按钮 `[data-testid=tweetButton]` 的文字变成「Schedule」 |
| 最后核对 | 点「安排」前调 `autocrew_content {action:"en_edition", content_id, edition:{op:"final_check", platform:"x"}}` | 回 `ok:true` 且 `package_hash` 和出包时一致才往下；不一致或被拒就停，不点 |
| 提交 | 保存发布记录后点一次「安排」 | 提示已安排；「未发送的帖子 → 已安排」里有这条。实测：tweetButton 被透明层挡住，用 focus + Enter 提交（见开头的通用坑）。toast 原文是「Your post will be sent on Mon, Oct 26, 2026 at 9:30 PM」，页面回到 `/home`。核对已安排列表就打开 `https://x.com/compose/post/unsent/scheduled` |
| 回执 | 记已安排列表里这条的时间与正文开头；公开后补帖子链接（`x.com/<用户名>/status/<id>`） | 状态「已安排」。实测调用：`autocrew_content {action:"record", kind:"publish", content_id, platform:"x", account:"@<handle>", pub_state:"scheduled", scheduled_at:"2026-10-26T21:30:00+08:00", request_id, note:<正文开头>}`，没有链接也能记，回 `verified:true` |

已安排的帖子要改要撤，在「未发送的帖子 → 已安排」里操作；英文成片换版后，旧的已安排帖子必须先撤掉再按新版重排，不能假设它会自己取消。

## 停下来的几种拒绝

- `derived_stale`（源视频成片换了一版）：对英文版 `edition:{op:"rebind"}`，按 video-session 英文版的做法重走变了的那几步；不删稿重派生。
- `line_unpicked`（「你取消了勾选……」）：创始人把这个平台取消勾选了，这一路停发；照原话告诉他，重新勾上就接着发。

## 适用与失效

只使用当前 snapshot/DOM 已观察到的目标。旧 ref、坐标、随机 class 后缀不复用。
成功条件未满足时不进入下一步。最终提交规则、回执和防重发见主 Skill 与发布契约（点之前先查本平台有没有已提交 / 已安排的回执）。
