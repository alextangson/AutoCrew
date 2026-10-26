# YouTube 操作（英文版）

> **已实测（2026-10-26，频道 Lawrence on AI，第一次定时发布全程走通）**：表里「实测」处是当时观察到的控件和故障。页面改版后，以当下的 snapshot 为准。

入口：https://studio.youtube.com （右上「创建 → 上传视频」）

发的是英文版那条稿（`en_edition` 派生稿）。英文版不走中文登记：只按**批过的英文发布包**发。先调 `autocrew_publish {action:"ego_lite_prepare", content_id:<英文版>}`（不带 check_ids），回执里每个平台的 `video_path` / `thumbnail_path` / 文案就是要上传和粘贴的东西，记下 `package_hash`；回 `en_package_not_approved` 就停下，请创始人在「等你拍板」里批英文发布包（批过之后改过也会回到那里，原因写在那件里）。YouTube 用 `platform:"youtube"` 那一项：`title`、`description`（已含章节行和标签）、`tags`、`video_path`、`thumbnail_path`。默认时段：**北京时间 21:00–23:00（美国上午）**，不跟中文时段。

| 步骤 | 动作 | 成功条件 / 已知故障 |
|---|---|---|
| 账号 | 核对右上头像对应的频道名和频道 ID（Studio 网址里 `/channel/UC…`） | 与发布计划的账号一致。**没登录或登到别的账号：停下请创始人登录**，不跳过这个平台、不换账号。实测：频道名在 Studio 左栏头像下「Your channel」那一行（DOM `#entity-name`） |
| 上传 | 「创建 → 上传视频」，用文件选择控件选登记的英文成片 | 看到上传进度和「处理中 / 检查完毕」，不能只看 setInputFiles 成功；文件名与登记文件一致。实测：仪表盘上的「Upload videos」按钮会被一层遮罩挡住（div intercepts pointer events），直接打开 `https://studio.youtube.com/channel/<频道ID>/videos/upload?d=ud` 就会弹出上传框；文件输入框是 `input[name=Filedata]`，直接 setInputFiles。选完文件后标题默认填成文件名，右上角显示「Saved as private」（已存成私享草稿），右侧马上出现视频链接 `youtu.be/<id>` 和 Filename；进度在底栏（如「Uploading 6% ... 12 minutes left」），423MB 大约要 15 分钟以上 |
| 详细信息 | 标题、说明：清空后粘发布包原文 | 读回全文：标题 ≤100 字符；说明里章节行（`0:00 …` 起）完整、标签在末尾。实测：标题和说明都是 contenteditable（`ytcp-video-title #textbox` / `ytcp-video-description #textbox`），全选、删除后再粘贴；读回时 innerText 末尾会多一个 `\n`，比对前先 trimEnd。注意：英文发布包的 description 到章节行就结束了，**末尾没有标签**，标签只在 `tags` 字段里，填进「更多选项 → 标签」 |
| 缩略图 | 「上传缩略图」选登记的 16:9 图 | 预览出现这张图；账号没验证电话时这个按钮不可用——停下告诉创始人，不跳过。实测：按钮叫「Upload file」（`button#select-button`），`input#file-loader` 看上去也是可用的，所以从 DOM 上判断不出来。没验证电话时，点了不会出文件选择框，而是弹出「Unlock more on YouTube — To add custom thumbnails, verify your phone number.」（按钮 Cancel / Verify）。遇到这个就交给创始人点 Verify 验证，验证完再回来传图。**坑：创始人去验证时如果刷新了正在上传的页面，上传会中断**，内容列表那一行会显示「Upload interrupted — Click "resume upload" and select <文件名> to resume」。处理办法：点「Resume upload」，它不会弹文件选择框，而是生成一个 `input[name=Filedata][accept='.mp4']`，往里 setInputFiles 同一个登记文件，就能从断点续传（草稿和链接不变），然后点「Edit draft」回到编辑框。验证完成后要在新加载的页面上重试（可以另开一页进内容列表，别刷新正在上传的那页）；**视频 ID 要从 DOM 里取 `a[href*='youtu.be']`，别看截图认**：这次的 ID 是 `5woBAIbfUqk`（大写 I），截图上很像小写 l，拿认错的 ID 打开 `/video/<id>/edit` 会报「Oops, something went wrong.」 |
| 观众 | 「不是为儿童打造的」，按发布包 | 读回选中状态。实测：单选按钮是 `tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]`；频道设过默认值时会显示「This video is set to not made for kids — Set by you」 |
| 更多选项 | 「标签」逐个粘 tags；语言选 English；**AI use** 和 **Paid promotion** 按发布包填 | 标签都在框里。实测：「Show more」是 `ytcp-button#toggle-button`，用文字定位会被对话框挡住点不中。标签框是 `input[placeholder='Add tag']`，每个 tag 后面输一个逗号，读回 `ytcp-chip` 列表。视频语言下拉（`#language-input ytcp-dropdown-trigger`）的选项用选择器点不中，要先算出「English」那一项的坐标再用鼠标点，读回 `#language-input` 显示「Video language English」。**AI use（必答）**："Was AI used to generate or edit your content…"，第一条是 "Make a real person appear to say or do something they didn't say or do"，选 Yes 会给视频加 AI 标签。英文版用了 AI 配音（发布包里有 enDubHash），2026-10-26 创始人定的是选 **Yes**（`[aria-label='Yes, AI was used']`）。**这个答案应该写进英文发布包**，现在包里没有，填表时只能停下来问。Paid promotion 选 No（`VIDEO_PAID_PRODUCT_PLACEMENT_NO`） |
| 视频元素 / 检查 | 结束画面、卡片不加；等版权检查结果 | 有版权提示就停下报原文。实测：Video elements 页的字幕、结束画面、卡片都保持「Add」不动，直接点 `ytcp-button#next-button`。Checks 页在 SD 处理完之前一直显示「Checking if your video contains any copyrighted content」，要等上传到 100%、SD 处理完才出结果（423MB 从续传到出结果大约 20 分钟）。实测 2026-10-26：结果是「Claimed content was found in this video…」，底栏显示「Checks complete. Claimed content found.」，Checks 圆点变红。点「View details」（要用 role 定位或坐标点）能看到认领方（Sentric Music Publishing）、歌名（Uprising Sun，Melody or lyrics），以及被认领的时间段——这次是剪辑里用的背景音乐。按规定停下报原文；配乐要在剪辑阶段就避开会被 Content ID 认领的曲子 |
| 公开范围 | 选「安排时间」，日期时间设到计划的时段（时区按页面显示核对，换算成北京时间读回） | 读回日期、时间和时区；**不选「公开」立即发**。实测：展开「Schedule」后默认是明天 12:00 AM；「Time zone」按钮打开时区列表，第一项「(GMT+0800) Local Time」就是北京时间（按坐标点）；日期点下拉、在日历里点日子；时间框是 input，全选后输入「9:30 PM」再回车。读回值里 9:30 和 PM 之间是窄不换行空格（U+202F），做字符串比对要先归一化。读回内容：`Oct 26, 2026` / `9:30 PM` / `(GMT+0800) Local Time`，「Set as Premiere」不勾，底部按钮显示「Schedule」 |
| 最后核对 | 点「安排」前调 `autocrew_content {action:"en_edition", content_id, edition:{op:"final_check", platform:"youtube"}}` | 回 `ok:true` 且 `package_hash` 和出包时一致才往下；不一致或被拒就停，不点 |
| 提交 | 保存发布记录后点一次「安排」 | 弹出「视频已安排发布」和视频链接。实测：按钮是 `ytcp-button#done-button`；点完弹出「Video scheduled — Your video will be set to public on October 26, 2026 at 9:30 PM」和视频链接，按 `ytcp-button#close-button` 关掉 |
| 回执 | 记视频链接（`youtu.be/<id>`）、安排时间、状态「已安排」 | 内容页里本条显示为「已安排」。实测调用：`autocrew_content {action:"record", kind:"publish", content_id, platform:"youtube", url:"https://youtu.be/<id>", item_id:"<id>", pub_state:"scheduled", scheduled_at:"2026-10-26T21:30:00+08:00", account, request_id}`，回 `verified:true`、阶段「已发布」 |

章节在说明里生效的条件：第一个是 0:00、至少 3 个、每段 ≥10 秒——发布包交包时已核过，读回时只看有没有被截掉。

## 停下来的几种拒绝

- `derived_stale`（源视频成片换了一版）：对英文版 `edition:{op:"rebind"}`，按 video-session 英文版的做法重走变了的那几步；不删稿重派生。
- `line_unpicked`（「你取消了勾选……」）：创始人把这个平台取消勾选了，这一路停发；照原话告诉他，重新勾上就接着发。

## 适用与失效

只使用当前 snapshot/DOM 已观察到的目标。旧 ref、坐标、随机 class 后缀不复用。
成功条件未满足时不进入下一步。最终提交规则、回执和防重发见主 Skill 与发布契约（点之前先查本平台有没有已提交的回执）。
