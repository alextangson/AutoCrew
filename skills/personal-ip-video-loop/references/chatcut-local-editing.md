# ChatCut Desktop 本地剪辑

2026-10-07 用户确认“改一下 之后都用chatcut”：此后的剪辑和审片默认使用 ChatCut Desktop 本地版，本文件是默认执行路径。无需每次重问编辑器选择，不先转剪映；只有用户明确要求进剪映时，才执行入口文件的剪映交接。保留已有人工时间线，不因默认偏好变化自动迁移或重剪旧工程。

## 只调度能力，不用它的库

用户 2026-09-28 明确：ChatCut 只用来剪（放素材、跑 MG 代码、字幕、导出），不用它参考库里的风格、Design Style 预设、MG 模板和库存素材——用了会跟别人剪得一样。ChatCut 自带 MG 技能里「先浏览 style-overview 选参考」的流程对本用户不适用。视觉参考只用自家资产：已批准的蓝图动效样片、小鹿纸艺黏土世界、用户给的范例。

## 窗口归属：写入只落在「窗口里打开的项目」

ChatCut Desktop 的写入落在「当前绑定的项目」上。`target_project` 能把本会话绑到目标项目，但只要还有别的会话或 Codex 在操作 ChatCut，绑定会被中途切走——2026-09-28 绑定后第一次读取正确，几秒后创建的 MG 素材却落进了另一个项目。`get_active_project` 反映的是窗口状态，不能单独证明写入目标。

- 每一批写入前立刻 `read_project` 核对项目名和 ID；写入后用返回的 ID 或 `inspect_asset` 的 `projectId` 确认落点。落错就只删自己刚建、未被引用的东西，然后停下。
- 有别的会话在用 ChatCut 时不要写入，请用户先停掉它们；不自己把窗口抢过去。
- 多条视频同时由多个会话开工会互相把窗口切走（2026-09-28 五个会话在同一分钟里轮流覆盖）。一次只让一个会话用 ChatCut，剪完一条再派下一条；派活流程要排队，不要把「继续」同时发给多个会话。
- 同一条视频只留一个负责剪辑的会话。
- 开工前后各读一次画布宽高（`read_project`）。画布方向被意外改过就先报告，不要在错的画布上继续构图。

## 构图：竖屏文件里嵌横屏画面

手机录的原片常是 1080×1920 文件，横屏画面带上下黑边嵌在中间（约 1080×600 有效区）。

- ChatCut 的 crop 参数在这种素材上会把画面渲染成窄带；用「放大 + 平移」（`width` 锁比例、`left`/`top` 画布像素）让有效区铺满画布。
- 放大倍数有下限：有效区宽高都要盖住画布，1920×1080 画布约需 1.78 倍以上，再低必露黑边。
- 2026-09-28 那条桌前机位在 1920×1080 画布上的验收值：`width 2106, left 0, top -1315`（约 1.95 倍，人物居中、四边无黑边、胸前徽章在字幕带上方）。换机位或换画布要重新量，不要照搬数值。
- 每次改构图后抽帧看四边有没有黑线，并看字幕那一条高度上有没有徽章、手、产品按钮压字。挡字优先改构图，而不是把字幕挪出安全区。

## 字幕

样式按 [subtitle-packaging.md](subtitle-packaging.md)。ChatCut 里实测可用的一组（整条字幕共用 `style`，不逐卡改）：

`fontFamily: "Xinqingnian Ti"`、`color #FFFFFF`、`strokeWidth 0`、`textShadow "0 2px 6px rgba(0, 0, 0, 0.85)"`、`normalBackground null`、`fontSize 0.058`、`maxLines 1`。默认纵向位置（文字中线约在画面 89% 高度）已在安全区内；位置只能逐卡 `set_card_layout`（`top` 是画布像素），没有全局字段，所以不要为整体下移逐卡改。

ChatCut 自动生成的字幕按转写片段硬切，断句碎、会把残字粘到相邻卡上，不能直接交付。要做的是语义重断句：单行，每屏大约 16–18 字以内，断在说话的自然停顿处，不拆短语；AI 统一称「它」。有 Codex 校对过的 SRT 时，借它的分句和用字，但时间轴跟着 ChatCut 当前剪辑走。

操作上的坑：

- 先设 `maxLines: 1`，再做语义断句。反过来的话，打开单行时 ChatCut 会按宽度把超长卡自动硬切成新卡，还会把之前手修的卡拆回去。
- `split_card` 的 `beforeTokenId` 要用 `read_captions words=true` 返回的 `sourceTokenIds` 里的原始 ID，用显示用的 word `id` 会报「split boundary is invalid」。
- 拆出来的新卡 ID 是随机 UUID，不能按规律推算；合并前重新读那段时间的卡。
- `set_card_text` 会把被改的字并成一个 token，之后在那几个字中间拆不开；先拆合、最后再改字。
- `merge_cards` 是把这张和紧跟的下一张合并。
- 改完抽帧看：改过的位置 + 最长的几句（确认没有超宽被再次翻页）+ 浅色衣服/画面上的阴影可读性。

## 在 ChatCut 里直接写动效

会话本身就是 Opus 5.5 且在操作 ChatCut 时，由它直接用 `create_motion_graphic_from_code` 写整屏 MG（1920×1080，时长等于该镜时间窗），`edit_item` 放到 B-roll 轨；审美与意图按 [explainer-packaging.md](explainer-packaging.md)。

- 动作时间从 `preview_timeline views:["transcript"]` 取：以该镜起始帧为 0 换算每句话的相对帧，动作卡在词上。镜头要覆盖到这句话讲完；时间窗切在半句上时延长到句尾（下一个 B-roll 前没东西就放心延长）。
- 放好后按口播节拍抽 6–12 帧（`viewerFrames`），逐帧查：物件互相压住、文字被卡片挡、画面标签和字幕说同一句话、标签贴近字幕带。发现就改，改完抽同一批帧复核。
- 改已放置的 MG 用 `edit_asset update` + `json {"code": ...}`，资产 ID 和时间线位置不变；`codeFile` 需要 ChatCut 的 agent workspace，本机 CLI 会话里调不通。只改文字默认值时用 `json {"properties": [...]}`（整组传）。
- 校验器的坑：`open`、`history` 是被禁的全局名，变量别这么起；声明的属性都要以 `props.X` 读到并实际用上，读出来没用的颜色也会报错。
- B-roll 放完后，调 `autocrew_content check_slivers{content_id}` 找不到 1 秒的外露真人（入口规则见 SKILL.md），用它定位时间线空隙；它不检测素材内部或导出时的闪帧。导出后仍须按 [temporal-continuity-qa.md](temporal-continuity-qa.md) 对照原素材、原生预览与成片，检查剪切点附近连续帧。每处按返回的 `suggestion` 修：说话中 → 按前一段 B-roll 的类型补定格；气口 → 剪掉气口让两段 B-roll 接上。补定格的做法：
  - 动效：先 `edit_asset update json {"duration": 微秒}` 把素材拉长，再 `edit_item` 加长时间线条目。直接加长条目会报「source range exceeds asset」。动画按绝对帧写、最后停在定格帧时，多出来的就是静止画面；代码里读了 `durationInFrames` 的先检查。
  - 小鹿或视频：原片尾巴通常已经用完。用 ffmpeg 截最后一帧成 PNG，`push_asset` 后以 image 类型 `fit:"cover"` 放进缝里。
  - 修完再调一次 `check_slivers`，0 处才导出；导出后照常 `record kind=cut`。2026-09-29 那条一次补了 20 处。
- 源码同步存一份到项目 `03-broll/workspace/<版本>/motion/src/`，ChatCut 项目丢了还能重建。

## 导出放哪

剪辑软件的原始导出（还没做响度标准化的）是中间产物，直接导到 `99-cache/edit/raw-export/`；做完响度标准化、要拿去审或发布的成片才进 `07-delivery/` 并 record。

## 粗剪

取舍口径见 [four-gate-workflow.md](four-gate-workflow.md) Gate 1。ChatCut 里的顺序和坑（2026-09-30 实测）：

- 顺序：`read_script` 划重录和口吃 → `apply_script` → `clean_script only=silence silence=compress:300`（直接写入、没有预览）→ `manage_transcript fix` 改错字（词序号从 0 开始，先 `preview:true`）→ 开字幕、设样式 → 最后手修断句。`clean_script` 和 `apply_script` 都会重新生成字幕，手修的合并/拆分会被冲掉，所以断句永远放最后。
- 剪切点重叠：`apply_script` 会让相邻片段在原片上重叠约 10ms，`clean_script` 还会留下 1 帧孤片。后果是一闪而过的 1 字残卡、卡尾带被删词的首字（「第二天起来可」），音频有极短字头。每次剪完或压完都导出 SRT 查：短于 300ms 或只有 1–2 字的卡，以及以被删词首字结尾的卡。修法：孤片删掉（`deletes` 只传 `id`）；残字所在片段尾部剪 1 帧。
- 波纹：一次只改一处时，用单条 `updates` 加 `ripple:true` 就行。批量修剪不能批量 ripple（会重复位移，报 overlap）；先不带 ripple 批量修剪，再按原顺序重算每段的 `startFrame`，一次性紧排。紧排前先 `validateOnly`。
- 用户可能已在 ChatCut 里手动拖过剪切点：起止点落在转写字边界之外的就是人工改动，后续压缩和修剪都不要覆盖。
