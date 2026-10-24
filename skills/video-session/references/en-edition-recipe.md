# 英文版制作做法（前台步骤）

全媒体 spec §3.3 的标准做法，2026-10-23 demo 验证、创始人认可。**这一步在前台会话里做，不派后台 Codex**：ChatCut 的付费生成只有 ChatCut 窗口开着、有人确认时才放行（不开窗口会被自动拒），后台 Codex（审批策略 never）跑不了；一个 ChatCut 项目同一时间只接一个 MCP 客户端。开工前确认创始人在、能点确认；每次付费生成前先报价。

动 ChatCut 前按仓库 CLAUDE.md 拿锁（`mkdir ~/.cache/autocrew-yt/chatcut.lock`），这一段做完或要问创始人前放锁；写操作带明确的轨道 / item ID。

## 前提（产品核过才往下走）

- 英文脚本已在「等你拍板」里批过：`autocrew_content {action:"en_edition", content_id:<英文版>, edition:{op:"status"}}` 的 `approval` 是「已批准」。
- 配音已出、没被拒：`edition:{op:"dub"}` 回 `ok:true`，拿到 `manifest_path`、`tail_slowdown`、`slow_from_s`。回 `overrun_too_long` 就回去把脚本写短、重新请创始人批，不硬放慢；回 `tts_failed` 把原话告诉创始人（不换声音、不换 TTS）。

## 步骤

1. **摆音轨**：按清单 `lines[]` 的 `startS` 把每段 mp3 放上去（清单保证顺排、间隔 ≥0.15 秒、不早于时间槽，不要自己挪）。
2. **画面重排时**：`tail_slowdown` > 1 时，从 `slow_from_s` 到结尾把画面放慢这个倍数（≤1.15，清单已核过）；口型对齐的脸上**不放定格帧**。原中文音轨按同一倍数 atempo 一起放慢——口型对齐的服务要参考视频里带原始人声。
3. **口型对齐参考视频**：导出重排后的画面 + 原中文人声，**小于 50 MiB**（超了先降码率再导）。没有音轨会被拒（demo 里第一次就因为「video has no audio track」失败）。
4. **口型对齐**：ChatCut `submit_lipsync`，模式 `preserve-video`，参考视频 = 第 3 步那份，音频 = 第 1 步排好的英文配音。只对 A-roll 口播段；先报价，创始人确认后再提交。
5. **MG / 字卡**：中文字的 MG 卡按英文重做（ChatCut MG 是代码）；B-roll 里的中文截图保留，加英文说明条。
6. **字幕（style A）**：`edition:{op:"captions"}` 生成 cues（文字只取批过的脚本，时间取配音的字级时间戳），再按回执的 `burn_command` 跑 `sidecars/captions/burn_captions.py`：Avenir Next Demi Bold 54px、白字、柔和深色阴影、底部居中最多两行、每条最多一个黄色关键词、整条一起出一起收。脚本拒绝的 cue（三行、两个关键词、重叠、超长）不要手改 JSON 绕过，回去改脚本或分条。
7. **登记与审片**：英文成片和中文成片走同一套审片——对英文版这条稿 `autocrew_content record kind:cut`（字幕 `kind:srt` 绑这版成片）、`mark_ready`，再 `autocrew_review_inbox list` 把成片那件给创始人看。**他必须亲耳听**：克隆声音是最大风险，嘴型（牙齿、糊）也在这里抓。

## 记下来的坑

- 默认声音参数听起来像播音员；用 settings 里的 stability 0.3 / similarity 0.8 / style 0.35 / speaker boost。
- 下一步改进：用一段自由说话的英文录音重新克隆，比念稿克隆自然。
