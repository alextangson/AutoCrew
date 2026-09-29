# 剪完未登记提醒（2026-09-29，创始人已确认边界）

## 为什么

直派/场外剪辑的视频剪完、封面也做了，但从没 `autocrew_video handoff` / `register`，看板一直停在「已过审 / 草稿就绪」。例：content-1790472579181-pzey0m 成片在 `~/Movies/ChatCut/客户问一句你们用AI吗-长版-1080p.mp4`、封面用 `autocrew_asset add type=cover` 回传，状态仍 approved。提醒只让人看见，**不自动交接、不自动登记**。

## 判据

候选：视频平台稿（`isVideoPlatform`），状态 `draft_ready` 或 `approved`（没交接）。满足任一信号即「剪完未登记」：

1. **导出文件**：`~/Movies/ChatCut/`（常量）或设置里的剪映导出目录（`getVideoSettingsRaw(dataDir).jianyingExportDir`，没设就跳过）下，顶层 `.mp4` / `.mov` 文件名对得上标题。
2. **封面附件**：`content.assets` 里有 `type === "cover"`。
3. **项目封面**：绑定项目（`resolveContentProject`）的 `05-cover/` 下任意子目录（含非 vNNN 的 review-* 等）有 png/jpg/jpeg/webp。只看有没有，不读图、不算哈希。

标题匹配：两边都去掉空白和标点（中英文标点、「」、？等，保留汉字/字母/数字，字母转小写），再去掉文件名尾部常见后缀段（先按 `-` 或 `_` 切，取第一段；即 `客户问一句你们用AI吗-长版-1080p` → `客户问一句你们用ai吗`）。**文件名规范化结果是标题规范化结果的前缀，且长度 ≥ 6** 才算命中。不做模糊猜测。命中时记下文件名，给人判断。

一个目录只 `readdir` 一次（不递归、不 stat 大文件内容）；hook 每次会话开头跑，必须便宜。

## 显示

- `autocrew_status brief`（src/tools/status.ts `briefStatus`）：多一个桶 `cut_unregistered`，brief 一行变成 `N 待写 / N 等 A-roll / N 剪完未登记 / N 已派工待登记 / N 待发布`。命中的稿**从 awaiting_aroll 里扣掉**，不重复计数。
- `autocrew_desk inbox employee=editor`：把这些稿也列进去，每条带 `reason: "cut_unregistered"`、命中的信号（导出文件名 / 封面附件数 / 项目封面目录）和 next_action 的人话：「成片已在外面导出但没交接：先交接（handoff），成片与最终字幕放进项目 04-edit、封面放 05-cover/vNNN，创始人工作台批完再 register」。注意 editor inbox 现有条目的计数口径（brief 里 dispatched 用的是 editor inbox 过滤视频平台）——新条目**不能**被数进 dispatched；按 reason 区分或分开计算，保持两个桶互斥。
- 看板不改（创始人：先不加）。

## 读不了目录

ChatCut 导出目录或剪映导出目录存在但读失败（EACCES/EPERM 等，非 ENOENT）→ 不静默：brief 结果带 `warnings: ["读不了 ChatCut 导出目录：<path>（<code>）"]`，brief 文本末尾追加「（读不了 ChatCut 导出目录）」。目录不存在（ENOENT）= 正常，没信号。

## 封面附件守卫

`autocrew_asset add`，`type === "cover"`，目标稿是视频平台且状态不是 `editing` / `publish_ready`：照常保存（不破坏现有行为），回执加 `warning`：「这张封面只存成了附件，进不了封面审批（gate4）：交接后放进项目 05-cover/vNNN/（带 cover-manifest.json），在工作台批」。其他情况回执不变。

## 不做

- 不自动 handoff / register / 改状态；不扫 Downloads；不做模糊匹配；看板不加标记；不递归扫目录。

## 验收（测试）

- 规范化与前缀匹配：`客户问一句你们用AI吗-长版-1080p.mp4` 命中「客户问一句「你们用 AI 吗」，你答得上来吗」；`你每天纠正AI同一件事-1080p.mp4` 命中「你每天纠正 AI 同一件事？它根本不会从纠正里学」；5 个字的前缀不命中；不是前缀（中间片段）不命中；`.wav` / `.srt` 不算。
- 三种信号各自触发；已 editing / published 的稿不算；公众号等非视频平台不算。
- brief 计数：命中稿从等 A-roll 扣掉；与已派工待登记互斥；总数守恒。
- 剪映目录未设置 → 只看 ChatCut 目录，不报错；目录 ENOENT 无 warning；EACCES 有 warning 且 brief 文本带提示。
- editor inbox 条目带 reason 与命中信号。
- asset add cover 在 draft_ready 视频稿上回 warning 且照常保存；editing 稿上不回 warning；非 cover 类型不回。
- 导出目录路径可注入（测试用临时目录），不碰真实 ~/Movies。
